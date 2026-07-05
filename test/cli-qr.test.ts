import { describe, expect, it } from 'vitest'
import { qr } from '../src/cli/pairing.ts'
import { configFileContent, harness, PATHS } from './cli-harness.ts'

describe('slopdeck qr', () => {
  it('renders a QR of the fragment-pairing URL built from config + prompted deck token', async () => {
    const { deps, said, qrRenders, hiddenPrompts } = harness({
      files: { [PATHS.configFile]: configFileContent('https://deck.example.com') },
      answers: { askHidden: 'deck-token-9' },
    })

    const result = await qr(deps)

    expect(result.ok).toBe(true)
    expect(hiddenPrompts).toHaveLength(1)
    expect(hiddenPrompts[0]!.toLowerCase()).toContain('deck token')
    expect(qrRenders).toEqual(['https://deck.example.com/#deck-token=deck-token-9'])
    expect(said.join('\n')).toContain('[qr for https://deck.example.com/#deck-token=deck-token-9]')
  })

  it('percent-encodes the token and tolerates a trailing slash on the configured gateway URL', async () => {
    const { deps, qrRenders } = harness({
      files: { [PATHS.configFile]: configFileContent('https://deck.example.com/') },
      answers: { askHidden: 'a+b/c#d' },
    })

    await qr(deps)

    expect(qrRenders).toEqual(['https://deck.example.com/#deck-token=a%2Bb%2Fc%23d'])
  })

  it('never writes the deck token to disk', async () => {
    const { deps, writes, disk } = harness({
      files: { [PATHS.configFile]: configFileContent() },
      answers: { askHidden: 'deck-token-9' },
    })

    await qr(deps)

    expect(writes).toHaveLength(0)
    expect(disk.get(PATHS.configFile)).not.toContain('deck-token-9')
  })

  it('without a config file, points at install instead of rendering', async () => {
    const { deps, said, qrRenders } = harness({})

    const result = await qr(deps)

    expect(result.ok).toBe(false)
    expect(qrRenders).toHaveLength(0)
    expect(said.join('\n')).toContain('slopdeck install')
  })

  it('a blank deck token is refused — an empty-token QR would pair nothing', async () => {
    const { deps, qrRenders } = harness({
      files: { [PATHS.configFile]: configFileContent() },
      answers: { askHidden: '' },
    })

    const result = await qr(deps)

    expect(result.ok).toBe(false)
    expect(qrRenders).toHaveLength(0)
  })
})
