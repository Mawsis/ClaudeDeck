import { describe, expect, it } from 'vitest'
import { install, uninstall } from '../src/cli/install.ts'
import { harness, okClient, PATHS } from './cli-harness.ts'

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

    expect(hiddenPrompts[0]!.toLowerCase()).toContain('hook token')
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

describe('slopdeck install — pairing epilogue', () => {
  it('ends with QR, then handshake, then the "look at your phone" instruction, in that order', async () => {
    const handshakes: Array<{ token: string; sessionId: string; cwd: string }> = []
    const { deps, said, qrRenders } = harness({
      answers: { askHidden: ['hook-token-1', 'deck-token-9'] },
      client: okClient({
        handshake: async (token, session) => {
          handshakes.push({ token, sessionId: session.sessionId, cwd: session.cwd })
          return { ok: true, value: 7 }
        },
      }),
    })

    const result = await install(deps, {})

    expect(result.ok).toBe(true)
    expect(qrRenders).toEqual(['https://deck.example.com/#deck-token=deck-token-9'])
    expect(handshakes).toEqual([
      { token: 'hook-token-1', sessionId: 'slopdeck-install', cwd: '/home/u/projects/demo' },
    ])
    const screen = said.join('\n')
    const qrAt = screen.indexOf('[qr for ')
    const phoneAt = screen.toLowerCase().indexOf('look at your phone')
    expect(qrAt).toBeGreaterThan(-1)
    expect(phoneAt).toBeGreaterThan(qrAt)
  })

  it('reports a failed handshake clearly, leaves the setup files in place, and says what to check', async () => {
    const { deps, disk, said } = harness({
      answers: { askHidden: ['hook-token-1', 'deck-token-9'] },
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
    expect(screen.toLowerCase()).toContain('check')
  })

  it('never writes the deck token to any file', async () => {
    const { deps, disk } = harness({
      answers: { askHidden: ['hook-token-1', 'deck-token-9'] },
    })

    await install(deps, {})

    for (const [, content] of disk) {
      expect(content).not.toContain('deck-token-9')
    }
  })

  it('a blank deck token skips the QR but still proves the pipeline with the handshake', async () => {
    let handshakes = 0
    const { deps, qrRenders } = harness({
      answers: { askHidden: ['hook-token-1', ''] },
      client: okClient({
        handshake: async () => {
          handshakes += 1
          return { ok: true, value: 7 }
        },
      }),
    })

    const result = await install(deps, {})

    expect(result.ok).toBe(true)
    expect(qrRenders).toHaveLength(0)
    expect(handshakes).toBe(1)
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
