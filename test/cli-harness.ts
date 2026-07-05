import type { GatewayClient, GatewayResult } from '../src/cli/gateway-client.ts'
import type { CliDeps } from '../src/cli/install.ts'

/**
 * Shared fake-I/O harness for CLI command tests: an in-memory disk, scripted
 * prompt answers, a fake gateway client, and capture arrays for everything
 * the command can observably do.
 */

export const PATHS = {
  configFile: '/home/u/.config/slopdeck/config.json',
  claudeSettings: '/home/u/.claude/settings.json',
  zshrc: '/home/u/.zshrc',
}

export function okClient(overrides: Partial<GatewayClient> = {}): GatewayClient {
  const yes: GatewayResult<true> = { ok: true, value: true }
  // Deterministic fake keys so a test can assert exactly what install/rotate
  // wrote to the zshrc and baked into the QR.
  const minted = { workspaceId: 'ws-1', hookKey: 'hook-key-1', deckKey: 'deck-key-1' }
  return {
    health: async () => yes,
    verifyHookToken: async () => yes,
    getPaused: async () => ({ ok: true, value: false }),
    setPaused: async (_token, paused) => ({ ok: true, value: paused }),
    handshake: async () => ({ ok: true, value: 1 }),
    mintLocal: async () => ({ ok: true, value: minted }),
    mintHosted: async () => ({ ok: true, value: minted }),
    rotate: async () => ({ ok: true, value: { hookKey: 'hook-key-2', deckKey: 'deck-key-2' } }),
    ...overrides,
  }
}

export function harness(options: {
  files?: Record<string, string>
  client?: GatewayClient
  env?: Record<string, string | undefined>
  /** The machine's detected LAN IP for the local path; undefined = none found. */
  lanIp?: string | undefined
  /** `askHidden` may be an array to script successive hidden prompts;
   * a lone string answers every one. */
  answers?: Partial<{
    ask: string
    askHidden: string | string[]
    confirm: boolean
    /** The local-vs-hosted (or any menu) choice; defaults to 'hosted'. */
    choose: string
  }>
}) {
  const disk = new Map(Object.entries(options.files ?? {}))
  const writes: string[] = []
  const said: string[] = []
  const hiddenPrompts: string[] = []
  const plainPrompts: string[] = []
  const choicePrompts: string[] = []
  const qrRenders: string[] = []

  const deps: CliDeps = {
    paths: PATHS,
    cwd: '/home/u/projects/demo',
    env: options.env ?? {},
    lanIp: () => options.lanIp,
    io: {
      ask: async (question) => {
        plainPrompts.push(question)
        return options.answers?.ask ?? 'https://deck.example.com'
      },
      askHidden: async (question) => {
        hiddenPrompts.push(question)
        const scripted = options.answers?.askHidden ?? 'hook-token-1'
        if (typeof scripted === 'string') return scripted
        return scripted[hiddenPrompts.length - 1] ?? ''
      },
      confirm: async (_question, defaultYes) => options.answers?.confirm ?? defaultYes,
      choose: async (question, choices) => {
        choicePrompts.push(question)
        return options.answers?.choose ?? choices[choices.length - 1]!
      },
      say: (line) => said.push(line),
    },
    files: {
      read: async (path) => disk.get(path) ?? null,
      write: async (path, content) => {
        disk.set(path, content)
        writes.push(path)
      },
      remove: async (path) => {
        disk.delete(path)
        writes.push(`rm:${path}`)
      },
    },
    createClient: () => options.client ?? okClient(),
    renderQr: (text) => {
      qrRenders.push(text)
      return `[qr for ${text}]`
    },
  }
  return { deps, disk, writes, said, hiddenPrompts, plainPrompts, choicePrompts, qrRenders }
}

/** A config file as `slopdeck install` writes it — including the deck key. */
export function configFileContent(
  gatewayUrl = 'https://deck.example.com',
  deckKey: string | undefined = 'deck-key-1',
): string {
  const body = deckKey === undefined
    ? { gatewayUrl, interceptQuestions: false }
    : { gatewayUrl, interceptQuestions: false, deckKey }
  return JSON.stringify(body, null, 2) + '\n'
}
