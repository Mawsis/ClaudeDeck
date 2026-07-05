import { describe, expect, it } from 'vitest'
import { rotate } from '../src/cli/rotate.ts'
import { addZshrcBlock } from '../src/cli/settings-surgeon.ts'
import { configFileContent, harness, okClient, PATHS } from './cli-harness.ts'

/**
 * `slopdeck rotate` re-keys a workspace: it presents the current deck key as
 * proof (holding the key is the auth), the gateway mints a fresh pair, and the
 * CLI re-inscribes both sides — new hook key in the zshrc block, new deck key
 * in the config + QR. The currently-paired phone is disconnected until it
 * re-scans; the old keys stop authenticating.
 */
function rotateHarness(overrides: Parameters<typeof harness>[0] = {}) {
  return harness({
    files: {
      [PATHS.configFile]: configFileContent('https://deck.example.com', 'deck-key-1'),
      [PATHS.zshrc]: addZshrcBlock('', 'hook-key-1'),
    },
    ...overrides,
  })
}

describe('slopdeck rotate', () => {
  it('presents the current deck key, mints a fresh pair, and re-inscribes both sides', async () => {
    const rotatedWith: string[] = []
    const { deps, disk } = rotateHarness({
      client: okClient({
        rotate: async (currentKey) => {
          rotatedWith.push(currentKey)
          return { ok: true, value: { hookKey: 'hook-key-2', deckKey: 'deck-key-2' } }
        },
      }),
    })

    const result = await rotate(deps)

    expect(result.ok).toBe(true)
    // Proof presented is the old deck key from config.
    expect(rotatedWith).toEqual(['deck-key-1'])
    // The fresh hook key replaces the old one in the zshrc block.
    expect(disk.get(PATHS.zshrc)).toContain("export SLOPDECK_HOOK_TOKEN='hook-key-2'")
    expect(disk.get(PATHS.zshrc)).not.toContain('hook-key-1')
    // The fresh deck key replaces the old one in the config.
    expect(JSON.parse(disk.get(PATHS.configFile)!).deckKey).toBe('deck-key-2')
  })

  it('reprints the pairing QR with the new deck key', async () => {
    const { deps, qrRenders } = rotateHarness({
      client: okClient({
        rotate: async () => ({ ok: true, value: { hookKey: 'hook-key-2', deckKey: 'deck-key-2' } }),
      }),
    })

    await rotate(deps)

    expect(qrRenders).toEqual(['https://deck.example.com/#deck-token=deck-key-2'])
  })

  it('states that the currently-paired phone disconnects until it re-scans', async () => {
    const { deps, said } = rotateHarness()

    await rotate(deps)

    const screen = said.join('\n').toLowerCase()
    expect(screen).toContain('disconnect')
    expect(screen).toContain('re-scan')
  })

  it('leaves the old keys in place when the gateway rejects the rotation — no partial re-inscription', async () => {
    const { deps, disk, writes } = rotateHarness({
      client: okClient({
        rotate: async () => ({ ok: false, error: 'unauthorized', status: 401 }),
      }),
    })

    const result = await rotate(deps)

    expect(result.ok).toBe(false)
    expect(writes).toHaveLength(0)
    expect(disk.get(PATHS.zshrc)).toContain('hook-key-1')
    expect(JSON.parse(disk.get(PATHS.configFile)!).deckKey).toBe('deck-key-1')
  })

  it('without a config, points at install instead of rotating', async () => {
    const { deps, said, writes } = harness({})

    const result = await rotate(deps)

    expect(result.ok).toBe(false)
    expect(writes).toHaveLength(0)
    expect(said.join('\n')).toContain('slopdeck install')
  })

  it('a config with no deck key cannot prove ownership — points at install', async () => {
    const { deps, writes } = harness({
      files: {
        [PATHS.configFile]:
          JSON.stringify({ gatewayUrl: 'https://deck.example.com', interceptQuestions: false }) + '\n',
      },
    })

    const result = await rotate(deps)

    expect(result.ok).toBe(false)
    expect(writes).toHaveLength(0)
  })
})
