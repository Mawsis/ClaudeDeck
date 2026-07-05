import { describe, expect, it } from 'vitest'
import { install, uninstall } from '../src/cli/install.ts'
import { harness, okClient, PATHS } from './cli-harness.ts'

describe('slopdeck install — hosted path', () => {
  it('auto-mints against the hosted gateway with no hand-typed or hand-generated token', async () => {
    const { deps, disk, hiddenPrompts } = harness({ answers: { choose: 'hosted' } })

    const result = await install(deps, {})

    expect(result.ok).toBe(true)
    // No hidden prompt for any token — the whole point of zero-token install.
    expect(hiddenPrompts).toHaveLength(0)
    const config = JSON.parse(disk.get(PATHS.configFile)!)
    expect(config.gatewayUrl).toBe('https://slopdeck.com')
    // The minted hook key lands in the zshrc block; the deck key in config.
    expect(disk.get(PATHS.zshrc)).toContain("export SLOPDECK_HOOK_TOKEN='hook-key-1'")
    expect(config.deckKey).toBe('deck-key-1')
  })

  it('ends in a scannable QR pointing the phone at the hosted domain', async () => {
    const { deps, qrRenders } = harness({ answers: { choose: 'hosted' } })

    await install(deps, {})

    expect(qrRenders).toEqual(['https://slopdeck.com/#deck-token=deck-key-1'])
  })
})

describe('slopdeck install — local path', () => {
  it('mints locally and bakes the detected LAN IP into the pairing QR', async () => {
    const { deps, qrRenders } = harness({
      answers: { choose: 'local', ask: 'http://localhost:8484' },
      lanIp: '192.168.1.42',
    })

    const result = await install(deps, {})

    expect(result.ok).toBe(true)
    // The phone cannot reach "localhost" — the QR must carry the machine's LAN
    // IP and the gateway port so the phone finds it on the same Wi-Fi.
    expect(qrRenders).toEqual(['http://192.168.1.42:8484/#deck-token=deck-key-1'])
  })

  it('surfaces the in-page-alerts-only tradeoff for local', async () => {
    const { deps, said } = harness({
      answers: { choose: 'local', ask: 'http://localhost:8484' },
      lanIp: '192.168.1.42',
    })

    await install(deps, {})

    const screen = said.join('\n').toLowerCase()
    expect(screen).toContain('in-page alerts')
    expect(screen).toContain('hosted')
  })

  it('aborts without writing when no LAN IP can be detected', async () => {
    const { deps, writes, said } = harness({
      answers: { choose: 'local', ask: 'http://localhost:8484' },
      lanIp: undefined,
    })

    const result = await install(deps, {})

    expect(result.ok).toBe(false)
    expect(writes).toHaveLength(0)
    expect(said.join('\n').toLowerCase()).toContain('lan ip')
  })
})

describe('slopdeck install — warnings and secrets', () => {
  it('prints the loud anonymous-key warning and the honest privacy line', async () => {
    const { deps, said } = harness({ answers: { choose: 'hosted' } })

    await install(deps, {})

    const screen = said.join('\n')
    expect(screen).toContain('only way to reach your deck')
    expect(screen.toLowerCase()).toContain('folder names')
    expect(screen.toLowerCase()).toContain('not your credentials')
  })

  it('never writes the deck key to the claude settings or the zshrc block', async () => {
    const { deps, disk } = harness({ answers: { choose: 'hosted' } })

    await install(deps, {})

    expect(disk.get(PATHS.claudeSettings)).not.toContain('deck-key-1')
    expect(disk.get(PATHS.zshrc)).not.toContain('deck-key-1')
  })

  it('never writes the hook key to the config file', async () => {
    const { deps, disk } = harness({ answers: { choose: 'hosted' } })

    await install(deps, {})

    expect(disk.get(PATHS.configFile)).not.toContain('hook-key-1')
  })
})

describe('slopdeck install — validate-then-write discipline', () => {
  it('fails before any file is written when the mint call is unreachable', async () => {
    const { deps, writes, said } = harness({
      answers: { choose: 'hosted' },
      client: okClient({
        mintHosted: async () => ({ ok: false, error: 'unreachable', detail: 'ECONNREFUSED' }),
      }),
    })

    const result = await install(deps, {})

    expect(result.ok).toBe(false)
    expect(writes).toHaveLength(0)
    expect(said.join('\n')).toContain('unreachable')
  })

  it('rejects malformed pre-existing settings without any partial write — not even the config file', async () => {
    const { deps, writes } = harness({
      answers: { choose: 'hosted' },
      files: { [PATHS.claudeSettings]: '{broken' },
    })

    const result = await install(deps, {})

    expect(result.ok).toBe(false)
    expect(writes).toHaveLength(0)
  })

  it('preserves foreign settings content through the merge', async () => {
    const { deps, disk } = harness({
      answers: { choose: 'hosted' },
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

  it('question interception defaults to no and is recorded; opting in adds the PreToolUse matcher', async () => {
    const defaulted = harness({ answers: { choose: 'hosted' } })
    await install(defaulted.deps, {})
    expect(JSON.parse(defaulted.disk.get(PATHS.configFile)!).interceptQuestions).toBe(false)
    expect(JSON.parse(defaulted.disk.get(PATHS.claudeSettings)!).hooks.PreToolUse).toBeUndefined()

    const opted = harness({ answers: { choose: 'hosted', confirm: true } })
    await install(opted.deps, {})
    expect(JSON.parse(opted.disk.get(PATHS.configFile)!).interceptQuestions).toBe(true)
    expect(JSON.parse(opted.disk.get(PATHS.claudeSettings)!).hooks.PreToolUse[0].matcher).toBe(
      'AskUserQuestion',
    )
  })
})

describe('slopdeck install — pairing epilogue', () => {
  it('ends with QR, then handshake, then the "look at your phone" instruction, in that order', async () => {
    const handshakes: Array<{ token: string; sessionId: string; cwd: string }> = []
    const { deps, said, qrRenders } = harness({
      answers: { choose: 'hosted' },
      client: okClient({
        handshake: async (token, session) => {
          handshakes.push({ token, sessionId: session.sessionId, cwd: session.cwd })
          return { ok: true, value: 7 }
        },
      }),
    })

    const result = await install(deps, {})

    expect(result.ok).toBe(true)
    expect(qrRenders).toEqual(['https://slopdeck.com/#deck-token=deck-key-1'])
    // The handshake fires through the minted hook key, not a prompted one.
    expect(handshakes).toEqual([
      { token: 'hook-key-1', sessionId: 'slopdeck-install', cwd: '/home/u/projects/demo' },
    ])
    const screen = said.join('\n')
    const qrAt = screen.indexOf('[qr for ')
    const phoneAt = screen.toLowerCase().indexOf('look at your phone')
    expect(qrAt).toBeGreaterThan(-1)
    expect(phoneAt).toBeGreaterThan(qrAt)
  })

  it('reports a failed handshake clearly and leaves the setup files in place', async () => {
    const { deps, disk, said } = harness({
      answers: { choose: 'hosted' },
      client: okClient({
        handshake: async () => ({ ok: false, error: 'unreachable', detail: 'ECONNRESET' }),
      }),
    })

    const result = await install(deps, {})

    expect(result.ok).toBe(false)
    expect(disk.has(PATHS.configFile)).toBe(true)
    expect(disk.has(PATHS.claudeSettings)).toBe(true)
    expect(disk.has(PATHS.zshrc)).toBe(true)
    const screen = said.join('\n')
    expect(screen).toContain('handshake')
    expect(screen).toContain('files are in place')
  })
})

describe('slopdeck uninstall', () => {
  it('removes slopdeck hooks, the zshrc block, and the config file', async () => {
    const install1 = harness({ answers: { choose: 'hosted' } })
    await install(install1.deps, {})

    // Re-run uninstall over the same disk state.
    const result = await uninstall(install1.deps)

    expect(result.ok).toBe(true)
    expect(install1.disk.has(PATHS.configFile)).toBe(false)
    expect(install1.disk.get(PATHS.zshrc) ?? '').not.toContain('SLOPDECK_HOOK_TOKEN')
    const settings = JSON.parse(install1.disk.get(PATHS.claudeSettings) ?? '{}')
    const stopHooks = settings.hooks?.Stop ?? []
    expect(stopHooks).toHaveLength(0)
  })
})
