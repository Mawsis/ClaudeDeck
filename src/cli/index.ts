import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { homedir, networkInterfaces } from 'node:os'
import { dirname, join } from 'node:path'
import { createInterface, type Interface } from 'node:readline'
import { pathToFileURL } from 'node:url'
import qrcodeTerminal from 'qrcode-terminal'
import { createGatewayClient } from './gateway-client.ts'
import { install, uninstall, type CliDeps, type FileStore } from './install.ts'
import { qr } from './pairing.ts'
import { setInterception, status } from './remote.ts'
import { rotate } from './rotate.ts'

const USAGE = `usage:
  slopdeck install [--gateway-url https://your-deck-host]
  slopdeck uninstall
  slopdeck on|off     flip interception (the deck's Pause switch, remotely)
  slopdeck status     diagnose the whole chain on one screen
  slopdeck qr         re-print the phone-pairing QR
  slopdeck rotate     mint a fresh key and re-pair (the old key stops working)`

export type CliCommand = 'install' | 'uninstall' | 'on' | 'off' | 'status' | 'qr' | 'rotate'

export type CliArgs = {
  readonly command: CliCommand
  readonly gatewayUrl: string | undefined
}

const BARE_COMMANDS: readonly CliCommand[] = ['uninstall', 'on', 'off', 'status', 'qr', 'rotate']

export function parseCliArgs(argv: readonly string[]): CliArgs | null {
  const [command, ...rest] = argv
  // Tokens travel by hidden prompt only — no command takes one via argv,
  // where it would land in shell history.
  if (BARE_COMMANDS.includes(command as CliCommand)) {
    return rest.length === 0 ? { command: command as CliCommand, gatewayUrl: undefined } : null
  }
  if (command !== 'install') return null
  const flagIndex = rest.indexOf('--gateway-url')
  if (flagIndex === -1) return { command, gatewayUrl: undefined }
  const gatewayUrl = rest[flagIndex + 1]
  if (gatewayUrl === undefined || gatewayUrl.startsWith('--')) return null
  return { command, gatewayUrl }
}

function ask(question: string, hidden: boolean): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: true })
  if (hidden) {
    // Echo the prompt once, then swallow every keystroke's echo — the token
    // must never land on screen or in terminal scrollback.
    const raw = rl as Interface & { _writeToOutput?: (chunk: string) => void }
    let prompted = false
    raw._writeToOutput = (chunk: string) => {
      if (prompted) return
      prompted = true
      process.stdout.write(chunk)
    }
  }
  return new Promise((resolve) => {
    rl.question(`${question}: `, (answer) => {
      rl.close()
      if (hidden) process.stdout.write('\n')
      resolve(answer.trim())
    })
  })
}

/** The machine's first non-internal IPv4 — what the phone dials on the LAN.
 * Undefined if the machine has no such address (e.g. offline). */
function firstLanIpv4(): string | undefined {
  for (const addresses of Object.values(networkInterfaces())) {
    for (const address of addresses ?? []) {
      if (address.family === 'IPv4' && !address.internal) return address.address
    }
  }
  return undefined
}

function realFileStore(): FileStore {
  return {
    async read(path) {
      try {
        return await readFile(path, 'utf8')
      } catch {
        return null
      }
    },
    async write(path, content) {
      await mkdir(dirname(path), { recursive: true })
      await writeFile(path, content, 'utf8')
    },
    async remove(path) {
      await rm(path, { force: true })
    },
  }
}

export async function runCli(argv: readonly string[]): Promise<number> {
  const args = parseCliArgs(argv)
  if (args === null) {
    console.error(USAGE)
    return 2
  }

  const home = homedir()
  const deps: CliDeps = {
    paths: {
      configFile: join(home, '.config', 'slopdeck', 'config.json'),
      claudeSettings: join(home, '.claude', 'settings.json'),
      zshrc: join(home, '.zshrc'),
    },
    io: {
      ask: (question) => ask(question, false),
      askHidden: (question) => ask(question, true),
      confirm: async (question, defaultYes) => {
        const answer = await ask(`${question} [${defaultYes ? 'Y/n' : 'y/N'}]`, false)
        if (answer === '') return defaultYes
        return answer.toLowerCase().startsWith('y')
      },
      choose: async (question, choices) => {
        // Repeat until the answer names one of the choices; the first choice is
        // the default on a bare Enter.
        for (;;) {
          const answer = (await ask(`${question} (${choices.join('/')})`, false)).toLowerCase()
          if (answer === '') return choices[0]!
          const match = choices.find((choice) => choice.toLowerCase() === answer)
          if (match !== undefined) return match
        }
      },
      say: (line) => console.log(line),
    },
    files: realFileStore(),
    createClient: createGatewayClient,
    env: process.env,
    lanIp: firstLanIpv4,
    renderQr: (text) => {
      let rendered = ''
      // qrcode-terminal invokes the callback synchronously; small = half-height
      // blocks so the code fits a normal terminal.
      qrcodeTerminal.generate(text, { small: true }, (block) => {
        rendered = block
      })
      return rendered
    },
    cwd: process.cwd(),
  }

  switch (args.command) {
    case 'install':
      return (await install(deps, { gatewayUrl: args.gatewayUrl })).ok ? 0 : 1
    case 'uninstall':
      return (await uninstall(deps)).ok ? 0 : 1
    case 'on':
    case 'off':
      return (await setInterception(deps, args.command === 'on')).ok ? 0 : 1
    case 'status':
      return (await status(deps)).ok ? 0 : 1
    case 'qr':
      return (await qr(deps)).ok ? 0 : 1
    case 'rotate':
      return (await rotate(deps)).ok ? 0 : 1
  }
}

const invokedDirectly =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href
if (invokedDirectly) {
  runCli(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (error) => {
      console.error(error instanceof Error ? error.message : String(error))
      process.exit(1)
    },
  )
}
