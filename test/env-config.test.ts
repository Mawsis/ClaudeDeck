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

  it('defaults the alert threshold to 45s and honors an override', () => {
    expect(loadConfigFromEnv(validEnv).alertThresholdMs).toBe(45_000)
    expect(
      loadConfigFromEnv({ ...validEnv, CLAUDEDECK_ALERT_THRESHOLD_MS: '90000' }).alertThresholdMs,
    ).toBe(90_000)
  })

  it('rejects a malformed alert threshold, naming the variable', () => {
    for (const bad of ['soon', '-1', '0']) {
      expect(() =>
        loadConfigFromEnv({ ...validEnv, CLAUDEDECK_ALERT_THRESHOLD_MS: bad }),
      ).toThrow(/CLAUDEDECK_ALERT_THRESHOLD_MS/)
    }
  })

  it('runs without VAPID keys — push disabled, deck alerts still work', () => {
    expect(loadConfigFromEnv(validEnv).vapid).toBeUndefined()
  })

  it('loads the VAPID trio when fully configured', () => {
    const config = loadConfigFromEnv({
      ...validEnv,
      CLAUDEDECK_VAPID_PUBLIC_KEY: 'pub-key',
      CLAUDEDECK_VAPID_PRIVATE_KEY: 'priv-key',
      CLAUDEDECK_VAPID_SUBJECT: 'mailto:owner@example.com',
    })

    expect(config.vapid).toEqual({
      publicKey: 'pub-key',
      privateKey: 'priv-key',
      subject: 'mailto:owner@example.com',
    })
  })

  it('fails fast on a partial VAPID trio, naming what is missing', () => {
    expect(() =>
      loadConfigFromEnv({ ...validEnv, CLAUDEDECK_VAPID_PUBLIC_KEY: 'pub-key' }),
    ).toThrow(/CLAUDEDECK_VAPID_PRIVATE_KEY/)
    expect(() =>
      loadConfigFromEnv({
        ...validEnv,
        CLAUDEDECK_VAPID_PUBLIC_KEY: 'pub-key',
        CLAUDEDECK_VAPID_PRIVATE_KEY: 'priv-key',
      }),
    ).toThrow(/CLAUDEDECK_VAPID_SUBJECT/)
  })
})
