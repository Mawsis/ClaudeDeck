import { describe, expect, it } from 'vitest'
import { qr } from '../src/cli/pairing.ts'
import { configFileContent, harness, PATHS } from './cli-harness.ts'

describe('slopdeck qr', () => {
  it('renders a QR of the fragment-pairing URL built from the config deck key — no prompt', async () => {
    const { deps, said, qrRenders, hiddenPrompts } = harness({
      files: { [PATHS.configFile]: configFileContent('https://deck.example.com', 'deck-key-9') },
    })

    const result = await qr(deps)

    expect(result.ok).toBe(true)
    // The deck key comes from the config file install wrote — never a prompt.
    expect(hiddenPrompts).toHaveLength(0)
    expect(qrRenders).toEqual(['https://deck.example.com/#deck-token=deck-key-9'])
    expect(said.join('\n')).toContain('[qr for https://deck.example.com/#deck-token=deck-key-9]')
  })

  it('also prints the pairing URL as copy-paste text, with a treat-like-a-password caveat', async () => {
    const { deps, said } = harness({
      files: { [PATHS.configFile]: configFileContent('https://deck.example.com', 'deck-key-9') },
    })

    await qr(deps)

    const output = said.join('\n')
    // The same URL the QR encodes, as plain text for a second screen / manual entry.
    expect(output).toContain('https://deck.example.com/#deck-token=deck-key-9')
    // It carries the live key, so the printed line must flag it as sensitive.
    expect(output).toContain('treat it like a password')
  })

  it('percent-encodes the key and tolerates a trailing slash on the configured gateway URL', async () => {
    const { deps, qrRenders } = harness({
      files: { [PATHS.configFile]: configFileContent('https://deck.example.com/', 'a+b/c#d') },
    })

    await qr(deps)

    expect(qrRenders).toEqual(['https://deck.example.com/#deck-token=a%2Bb%2Fc%23d'])
  })

  it('swaps a localhost gateway for the detected LAN IP so the phone can reach it', async () => {
    const { deps, qrRenders } = harness({
      files: { [PATHS.configFile]: configFileContent('http://localhost:8484', 'deck-key-9') },
      lanIp: '192.168.1.42',
    })

    await qr(deps)

    expect(qrRenders).toEqual(['http://192.168.1.42:8484/#deck-token=deck-key-9'])
  })

  it.each(['http://0.0.0.0:8484', 'http://127.0.0.1:8484', 'http://[::1]:8484'])(
    'swaps other unreachable loopback/bind-all forms (%s) for the LAN IP too',
    async (gatewayUrl) => {
      const { deps, qrRenders } = harness({
        files: { [PATHS.configFile]: configFileContent(gatewayUrl, 'deck-key-9') },
        lanIp: '192.168.1.42',
      })

      await qr(deps)

      // None of these are dialable from a phone; all must be rewritten to the LAN IP.
      expect(qrRenders).toEqual(['http://192.168.1.42:8484/#deck-token=deck-key-9'])
    },
  )

  it('never writes the deck key to disk', async () => {
    const { deps, writes, disk } = harness({
      files: { [PATHS.configFile]: configFileContent('https://deck.example.com', 'deck-key-9') },
    })

    await qr(deps)

    expect(writes).toHaveLength(0)
  })

  it('without a config file, points at install instead of rendering', async () => {
    const { deps, said, qrRenders } = harness({})

    const result = await qr(deps)

    expect(result.ok).toBe(false)
    expect(qrRenders).toHaveLength(0)
    expect(said.join('\n')).toContain('slopdeck install')
  })

  it('a config with no deck key points at install rather than rendering an empty QR', async () => {
    const { deps, qrRenders, said } = harness({
      // A pre-workspaces config (env-token era) has no deck key at all.
      files: {
        [PATHS.configFile]:
          JSON.stringify({ gatewayUrl: 'https://deck.example.com', interceptQuestions: false }) + '\n',
      },
    })

    const result = await qr(deps)

    expect(result.ok).toBe(false)
    expect(qrRenders).toHaveLength(0)
    expect(said.join('\n')).toContain('slopdeck install')
  })
})
