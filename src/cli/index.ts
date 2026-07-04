import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { createInterface, type Interface } from 'node:readline'
import { pathToFileURL } from 'node:url'
import { createGatewayClient } from './gateway-client.ts'
import { install, uninstall, type CliDeps, type FileStore } from './install.ts'

const USAGE = `usage:
  slopdeck install [--gateway-url https://your-deck-host]
  slopdeck uninstall`

export type CliArgs = {
  readonly command: 'install' | 'uninstall'
  readonly gatewayUrl: string | undefined
}

export function parseCliArgs(argv: readonly string[]): CliArgs | null {
  const [command, ...rest] = argv
  if (command !== 'install' && command !== 'uninstall') return null
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
      say: (line) => console.log(line),
    },
    files: realFileStore(),
    createClient: createGatewayClient,
  }

  const outcome =
    args.command === 'install' ? await install(deps, { gatewayUrl: args.gatewayUrl }) : await uninstall(deps)
  return outcome.ok ? 0 : 1
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
