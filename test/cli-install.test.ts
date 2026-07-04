import { describe, expect, it } from 'vitest'
import type { GatewayClient, GatewayResult } from '../src/cli/gateway-client.ts'
import { install, uninstall, type CliDeps } from '../src/cli/install.ts'

const PATHS = {
  configFile: '/home/u/.config/slopdeck/config.json',
  claudeSettings: '/home/u/.claude/settings.json',
  zshrc: '/home/u/.zshrc',
}

function okClient(overrides: Partial<GatewayClient> = {}): GatewayClient {
  const yes: GatewayResult<true> = { ok: true, value: true }
  return {
    health: async () => yes,
    verifyHookToken: async () => yes,
    getPaused: async () => ({ ok: true, value: false }),
    setPaused: async (_token, paused) => ({ ok: true, value: paused }),
    handshake: async () => ({ ok: true, value: 1 }),
    ...overrides,
  }
}

function harness(options: {
  files?: Record<string, string>
  client?: GatewayClient
  answers?: Partial<{ ask: string; askHidden: string; confirm: boolean }>
}) {
  const disk = new Map(Object.entries(options.files ?? {}))
  const writes: string[] = []
  const said: string[] = []
  const hiddenPrompts: string[] = []
  const plainPrompts: string[] = []

  const deps: CliDeps = {
    paths: PATHS,
    io: {
      ask: async (question) => {
        plainPrompts.push(question)
        return options.answers?.ask ?? 'https://deck.example.com'
      },
      askHidden: async (question) => {
        hiddenPrompts.push(question)
        return options.answers?.askHidden ?? 'hook-token-1'
      },
      confirm: async (_question, defaultYes) => options.answers?.confirm ?? defaultYes,
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
  }
  return { deps, disk, writes, said, hiddenPrompts, plainPrompts }
}

describe('slopdeck install', () => {
  it('happy path: verifies gateway and token, then writes config, settings, and zshrc', async () => {
    const { deps, disk } = harness({})

    const result = await install(deps, {})

    expect(result.ok).toBe(true)
    const config = JSON.parse(disk.get(PATHS.configFile)!)
    expect(config).toEqual({ gatewayUrl: 'https://deck.example.com', interceptQuestions: false })
    const settings = JSON.parse(disk.get(PATHS.claudeSettings)!)
    expect(settings.hooks.Stop[0].hooks[0].url).toBe('https://deck.example.com/api/events')
    expect(disk.get(PATHS.zshrc)).toContain("export SLOPDECK_HOOK_TOKEN='hook-token-1'")
  })

  it('takes the gateway URL from a flag without prompting for it', async () => {
    const { deps, plainPrompts, disk } = harness({})

    await install(deps, { gatewayUrl: 'https://flagged.example.com' })

    expect(plainPrompts).toHaveLength(0)
    expect(JSON.parse(disk.get(PATHS.configFile)!).gatewayUrl).toBe('https://flagged.example.com')
  })

  it('reads the hook token via hidden input and stores it only in the zshrc block, never the config file', async () => {
    const { deps, disk, hiddenPrompts } = harness({})

    await install(deps, {})

    expect(hiddenPrompts).toHaveLength(1)
    expect(disk.get(PATHS.configFile)).not.toContain('hook-token-1')
    expect(disk.get(PATHS.claudeSettings)).not.toContain('hook-token-1')
    expect(disk.get(PATHS.zshrc)).toContain('hook-token-1')
  })

  it('fails before any file is written when the gateway is unreachable', async () => {
    const { deps, writes, said } = harness({
      client: okClient({
        health: async () => ({ ok: false, error: 'unreachable', detail: 'ECONNREFUSED' }),
      }),
    })

    const result = await install(deps, {})

    expect(result.ok).toBe(false)
    expect(writes).toHaveLength(0)
    expect(said.join('\n')).toContain('unreachable')
  })

  it('fails before any file is written when the hook token is rejected, with a clear message', async () => {
    const { deps, writes, said } = harness({
      client: okClient({
        verifyHookToken: async () => ({ ok: false, error: 'unauthorized', status: 401 }),
      }),
    })

    const result = await install(deps, {})

    expect(result.ok).toBe(false)
    expect(writes).toHaveLength(0)
    expect(said.join('\n').toLowerCase()).toContain('token')
  })

  it('question interception defaults to no and is recorded; opting in adds the PreToolUse matcher', async () => {
    const defaulted = harness({})
    await install(defaulted.deps, {})
    expect(JSON.parse(defaulted.disk.get(PATHS.configFile)!).interceptQuestions).toBe(false)
    expect(JSON.parse(defaulted.disk.get(PATHS.claudeSettings)!).hooks.PreToolUse).toBeUndefined()

    const opted = harness({ answers: { confirm: true } })
    await install(opted.deps, {})
    expect(JSON.parse(opted.disk.get(PATHS.configFile)!).interceptQuestions).toBe(true)
    expect(JSON.parse(opted.disk.get(PATHS.claudeSettings)!).hooks.PreToolUse[0].matcher).toBe(
      'AskUserQuestion',
    )
  })

  it('rejects malformed pre-existing settings without any partial write — not even the config file', async () => {
    const { deps, writes } = harness({ files: { [PATHS.claudeSettings]: '{broken' } })

    const result = await install(deps, {})

    expect(result.ok).toBe(false)
    expect(writes).toHaveLength(0)
  })

  it('preserves foreign settings content through the merge', async () => {
    const { deps, disk } = harness({
      files: {
        [PATHS.claudeSettings]: JSON.stringify({
          model: 'opus',
          hooks: { Stop: [{ hooks: [{ type: 'command', command: 'say done' }] }] },
        }),
        [PATHS.zshrc]: '# mine\nexport EDITOR=vim\n',
      },
    })

    await install(deps, {})

    const settings = JSON.parse(disk.get(PATHS.claudeSettings)!)
    expect(settings.model).toBe('opus')
    expect(settings.hooks.Stop).toHaveLength(2)
    expect(disk.get(PATHS.zshrc)).toContain('# mine\nexport EDITOR=vim\n')
  })
})

describe('slopdeck uninstall', () => {
  it('reverses install exactly: settings and zshrc restored, config removed', async () => {
    const originalSettings =
      JSON.stringify({ model: 'opus', hooks: { Stop: [{ hooks: [{ type: 'command', command: 'x' }] }] } }, null, 2) + '\n'
    const originalZshrc = '# mine\nexport EDITOR=vim\n'
    const { deps, disk } = harness({
      files: { [PATHS.claudeSettings]: originalSettings, [PATHS.zshrc]: originalZshrc },
    })
    await install(deps, {})

    const result = await uninstall(deps)

    expect(result.ok).toBe(true)
    expect(JSON.parse(disk.get(PATHS.claudeSettings)!)).toEqual(JSON.parse(originalSettings))
    expect(disk.get(PATHS.zshrc)).toBe(originalZshrc)
    expect(disk.has(PATHS.configFile)).toBe(false)
  })

  it('tells the user that already-running Claude sessions keep their hooks until restarted', async () => {
    const { deps, said } = harness({})
    await install(deps, {})

    await uninstall(deps)

    expect(said.join('\n').toLowerCase()).toContain('restart')
  })

  it('refuses to touch a malformed settings file, and writes nothing', async () => {
    const { deps, writes } = harness({ files: { [PATHS.claudeSettings]: 'not json at all {' } })

    const result = await uninstall(deps)

    expect(result.ok).toBe(false)
    expect(writes).toHaveLength(0)
  })
})
