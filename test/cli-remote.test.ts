import { describe, expect, it } from 'vitest'
import { generateHookSettings } from '../src/config-generator/generate.ts'
import { setInterception, status } from '../src/cli/remote.ts'
import { addHookSettings } from '../src/cli/settings-surgeon.ts'
import { configFileContent, harness, okClient, PATHS } from './cli-harness.ts'

/** Claude settings content exactly as `slopdeck install` leaves it. */
function installedSettings(): string {
  const surgery = addHookSettings('', generateHookSettings({ gatewayUrl: 'https://deck.example.com' }))
  if (!surgery.ok) throw new Error('fixture: settings surgery failed')
  return surgery.content
}

describe('slopdeck on / off', () => {
  it('on: prompts hidden for the deck token and unpauses the gateway', async () => {
    const calls: Array<{ token: string; paused: boolean }> = []
    const { deps, said, hiddenPrompts } = harness({
      files: { [PATHS.configFile]: configFileContent() },
      answers: { askHidden: 'deck-token-9' },
      client: okClient({
        setPaused: async (token, paused) => {
          calls.push({ token, paused })
          return { ok: true, value: paused }
        },
      }),
    })

    const result = await setInterception(deps, true)

    expect(result.ok).toBe(true)
    expect(hiddenPrompts).toHaveLength(1)
    expect(hiddenPrompts[0]!.toLowerCase()).toContain('deck token')
    expect(calls).toEqual([{ token: 'deck-token-9', paused: false }])
    expect(said.join('\n')).toContain('interception on')
  })

  it('off: pauses the gateway with the prompted deck token', async () => {
    const calls: Array<{ token: string; paused: boolean }> = []
    const { deps, said } = harness({
      files: { [PATHS.configFile]: configFileContent() },
      answers: { askHidden: 'deck-token-9' },
      client: okClient({
        setPaused: async (token, paused) => {
          calls.push({ token, paused })
          return { ok: true, value: paused }
        },
      }),
    })

    const result = await setInterception(deps, false)

    expect(result.ok).toBe(true)
    expect(calls).toEqual([{ token: 'deck-token-9', paused: true }])
    expect(said.join('\n')).toContain('interception off')
  })

  it('off against a dead gateway reports "already effectively off" and succeeds', async () => {
    const { deps, said } = harness({
      files: { [PATHS.configFile]: configFileContent() },
      client: okClient({
        setPaused: async () => ({ ok: false, error: 'unreachable', detail: 'ECONNREFUSED' }),
      }),
    })

    const result = await setInterception(deps, false)

    expect(result.ok).toBe(true)
    expect(said.join('\n')).toContain('gateway unreachable — interception is already effectively off')
  })

  it('on against a dead gateway fails — unreachable means it cannot be turned on', async () => {
    const { deps, said } = harness({
      files: { [PATHS.configFile]: configFileContent() },
      client: okClient({
        setPaused: async () => ({ ok: false, error: 'unreachable', detail: 'ECONNREFUSED' }),
      }),
    })

    const result = await setInterception(deps, true)

    expect(result.ok).toBe(false)
    expect(said.join('\n')).toContain('unreachable')
  })

  it('a rejected deck token is reported as such, distinctly from unreachability', async () => {
    const { deps, said } = harness({
      files: { [PATHS.configFile]: configFileContent() },
      client: okClient({
        setPaused: async () => ({ ok: false, error: 'unauthorized', status: 401 }),
      }),
    })

    const result = await setInterception(deps, false)

    expect(result.ok).toBe(false)
    expect(said.join('\n').toLowerCase()).toContain('deck token rejected')
  })

  it('without a config file, points at install and never prompts for a token', async () => {
    const { deps, said, hiddenPrompts } = harness({})

    const result = await setInterception(deps, true)

    expect(result.ok).toBe(false)
    expect(hiddenPrompts).toHaveLength(0)
    expect(said.join('\n')).toContain('slopdeck install')
  })
})

describe('slopdeck status', () => {
  it('healthy chain: every link reports positively on one screen', async () => {
    const { deps, said } = harness({
      files: {
        [PATHS.configFile]: configFileContent(),
        [PATHS.claudeSettings]: installedSettings(),
      },
      env: { SLOPDECK_HOOK_TOKEN: 'hook-token-1' },
      answers: { askHidden: 'deck-token-9' },
      client: okClient({ getPaused: async () => ({ ok: true, value: false }) }),
    })

    const result = await status(deps)

    expect(result.ok).toBe(true)
    const screen = said.join('\n')
    expect(screen).toContain('config')
    expect(screen).toContain('https://deck.example.com')
    expect(screen).toContain('hooks installed')
    expect(screen).toContain('SLOPDECK_HOOK_TOKEN visible in this shell')
    expect(screen).toContain('gateway reachable')
    expect(screen).toContain('hook token accepted')
    expect(screen).toContain('interception on')
  })
})

describe('slopdeck status — single-link failures stay identifiable', () => {
  it('distinguishes "env var missing in this shell" from "token rejected by gateway"', async () => {
    const missingEnv = harness({
      files: { [PATHS.configFile]: configFileContent(), [PATHS.claudeSettings]: installedSettings() },
      env: {},
      answers: { askHidden: '' },
    })
    expect((await status(missingEnv.deps)).ok).toBe(false)
    const missingScreen = missingEnv.said.join('\n')
    expect(missingScreen).toContain('SLOPDECK_HOOK_TOKEN missing in this shell')
    expect(missingScreen).toContain('hook token check skipped (SLOPDECK_HOOK_TOKEN missing in this shell)')
    expect(missingScreen).not.toContain('rejected')

    const rejected = harness({
      files: { [PATHS.configFile]: configFileContent(), [PATHS.claudeSettings]: installedSettings() },
      env: { SLOPDECK_HOOK_TOKEN: 'stale-token' },
      answers: { askHidden: '' },
      client: okClient({
        verifyHookToken: async () => ({ ok: false, error: 'unauthorized', status: 401 }),
      }),
    })
    expect((await status(rejected.deps)).ok).toBe(false)
    const rejectedScreen = rejected.said.join('\n')
    expect(rejectedScreen).toContain('SLOPDECK_HOOK_TOKEN visible in this shell')
    expect(rejectedScreen).toContain('hook token rejected by the gateway')
  })

  it('an unreachable gateway fails its own link; dependent checks report skipped, not failed', async () => {
    const { deps, said, hiddenPrompts } = harness({
      files: { [PATHS.configFile]: configFileContent(), [PATHS.claudeSettings]: installedSettings() },
      env: { SLOPDECK_HOOK_TOKEN: 'hook-token-1' },
      client: okClient({
        health: async () => ({ ok: false, error: 'unreachable', detail: 'ECONNREFUSED' }),
      }),
    })

    const result = await status(deps)

    expect(result.ok).toBe(false)
    const screen = said.join('\n')
    expect(screen).toContain('gateway unreachable')
    expect(screen).toContain('hook token check skipped (gateway unreachable)')
    expect(screen).toContain('pause state skipped (gateway unreachable)')
    expect(hiddenPrompts).toHaveLength(0)
  })

  it('missing hooks in Claude settings is its own failing link while the rest stay green', async () => {
    const { deps, said } = harness({
      files: {
        [PATHS.configFile]: configFileContent(),
        [PATHS.claudeSettings]: JSON.stringify({ model: 'opus' }),
      },
      env: { SLOPDECK_HOOK_TOKEN: 'hook-token-1' },
      answers: { askHidden: '' },
    })

    const result = await status(deps)

    expect(result.ok).toBe(false)
    const screen = said.join('\n')
    expect(screen).toContain('hooks not installed')
    expect(screen).toContain('gateway reachable')
    expect(screen).toContain('hook token accepted')
  })

  it('skipping the pause check with a blank deck token does not fail an otherwise healthy chain', async () => {
    const { deps, said } = harness({
      files: { [PATHS.configFile]: configFileContent(), [PATHS.claudeSettings]: installedSettings() },
      env: { SLOPDECK_HOOK_TOKEN: 'hook-token-1' },
      answers: { askHidden: '' },
    })

    const result = await status(deps)

    expect(result.ok).toBe(true)
    expect(said.join('\n')).toContain('pause state skipped (no deck token provided)')
  })
})

describe('malformed config file', () => {
  it('is reported as malformed with a pointer at install, without prompting or contacting the gateway', async () => {
    const { deps, said, hiddenPrompts } = harness({
      files: { [PATHS.configFile]: '{not json' },
    })

    const result = await setInterception(deps, true)

    expect(result.ok).toBe(false)
    expect(hiddenPrompts).toHaveLength(0)
    expect(said.join('\n')).toContain('malformed')
    expect(said.join('\n')).toContain('slopdeck install')
  })
})
