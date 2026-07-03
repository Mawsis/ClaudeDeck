import { describe, expect, it } from 'vitest'
import { loadConfigFromEnv } from '../src/gateway/env-config.ts'

const validEnv = {
  CLAUDEDECK_HOOK_TOKEN: 'hook-token-0123456789abcdef0123456789',
  CLAUDEDECK_DECK_TOKEN: 'deck-token-0123456789abcdef0123456789',
}

describe('env config', () => {
  it('loads tokens and defaults the port to 8484', () => {
    const config = loadConfigFromEnv(validEnv)

    expect(config.hookToken).toBe(validEnv.CLAUDEDECK_HOOK_TOKEN)
    expect(config.deckToken).toBe(validEnv.CLAUDEDECK_DECK_TOKEN)
    expect(config.port).toBe(8484)
  })

  it('honors an explicit PORT', () => {
    const config = loadConfigFromEnv({ ...validEnv, PORT: '9000' })

    expect(config.port).toBe(9000)
  })

  it('fails fast when a token is missing, naming the variable', () => {
    expect(() => loadConfigFromEnv({ CLAUDEDECK_HOOK_TOKEN: validEnv.CLAUDEDECK_HOOK_TOKEN })).toThrow(
      /CLAUDEDECK_DECK_TOKEN/,
    )
    expect(() => loadConfigFromEnv({})).toThrow(/CLAUDEDECK_HOOK_TOKEN/)
  })

  it('rejects tokens that are identical — scopes must be distinguishable', () => {
    expect(() =>
      loadConfigFromEnv({
        CLAUDEDECK_HOOK_TOKEN: validEnv.CLAUDEDECK_HOOK_TOKEN,
        CLAUDEDECK_DECK_TOKEN: validEnv.CLAUDEDECK_HOOK_TOKEN,
      }),
    ).toThrow(/identical/)
  })
})
