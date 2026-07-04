import { describe, expect, it } from 'vitest'
import { loadConfigFromEnv } from '../src/gateway/env-config.ts'

const validEnv = {
  SLOPDECK_HOOK_TOKEN: 'hook-token-0123456789abcdef0123456789',
  SLOPDECK_DECK_TOKEN: 'deck-token-0123456789abcdef0123456789',
}

describe('env config', () => {
  it('loads tokens and defaults the port to 8484', () => {
    const config = loadConfigFromEnv(validEnv)

    expect(config.hookToken).toBe(validEnv.SLOPDECK_HOOK_TOKEN)
    expect(config.deckToken).toBe(validEnv.SLOPDECK_DECK_TOKEN)
    expect(config.port).toBe(8484)
  })

  it('honors an explicit PORT', () => {
    const config = loadConfigFromEnv({ ...validEnv, PORT: '9000' })

    expect(config.port).toBe(9000)
  })

  it('fails fast when a token is missing, naming the variable', () => {
    expect(() => loadConfigFromEnv({ SLOPDECK_HOOK_TOKEN: validEnv.SLOPDECK_HOOK_TOKEN })).toThrow(
      /SLOPDECK_DECK_TOKEN/,
    )
    expect(() => loadConfigFromEnv({})).toThrow(/SLOPDECK_HOOK_TOKEN/)
  })

  it('rejects tokens that are identical — scopes must be distinguishable', () => {
    expect(() =>
      loadConfigFromEnv({
        SLOPDECK_HOOK_TOKEN: validEnv.SLOPDECK_HOOK_TOKEN,
        SLOPDECK_DECK_TOKEN: validEnv.SLOPDECK_HOOK_TOKEN,
      }),
    ).toThrow(/identical/)
  })

  it('defaults the alert threshold to 45s and honors an override', () => {
    expect(loadConfigFromEnv(validEnv).alertThresholdMs).toBe(45_000)
    expect(
      loadConfigFromEnv({ ...validEnv, SLOPDECK_ALERT_THRESHOLD_MS: '90000' }).alertThresholdMs,
    ).toBe(90_000)
  })

  it('rejects a malformed alert threshold, naming the variable', () => {
    for (const bad of ['soon', '-1', '0']) {
      expect(() =>
        loadConfigFromEnv({ ...validEnv, SLOPDECK_ALERT_THRESHOLD_MS: bad }),
      ).toThrow(/SLOPDECK_ALERT_THRESHOLD_MS/)
    }
  })

  it('defaults the question timeout to 60s and honors an override', () => {
    expect(loadConfigFromEnv(validEnv).questionTimeoutMs).toBe(60_000)
    expect(
      loadConfigFromEnv({ ...validEnv, SLOPDECK_QUESTION_TIMEOUT_MS: '15000' }).questionTimeoutMs,
    ).toBe(15_000)
  })

  it('rejects a malformed question timeout, naming the variable', () => {
    for (const bad of ['soon', '-1', '0']) {
      expect(() =>
        loadConfigFromEnv({ ...validEnv, SLOPDECK_QUESTION_TIMEOUT_MS: bad }),
      ).toThrow(/SLOPDECK_QUESTION_TIMEOUT_MS/)
    }
  })

  it('runs without VAPID keys — push disabled, deck alerts still work', () => {
    expect(loadConfigFromEnv(validEnv).vapid).toBeUndefined()
  })

  it('loads the VAPID trio when fully configured', () => {
    const config = loadConfigFromEnv({
      ...validEnv,
      SLOPDECK_VAPID_PUBLIC_KEY: 'pub-key',
      SLOPDECK_VAPID_PRIVATE_KEY: 'priv-key',
      SLOPDECK_VAPID_SUBJECT: 'mailto:owner@example.com',
    })

    expect(config.vapid).toEqual({
      publicKey: 'pub-key',
      privateKey: 'priv-key',
      subject: 'mailto:owner@example.com',
    })
  })

  it('fails fast on a partial VAPID trio, naming what is missing', () => {
    expect(() =>
      loadConfigFromEnv({ ...validEnv, SLOPDECK_VAPID_PUBLIC_KEY: 'pub-key' }),
    ).toThrow(/SLOPDECK_VAPID_PRIVATE_KEY/)
    expect(() =>
      loadConfigFromEnv({
        ...validEnv,
        SLOPDECK_VAPID_PUBLIC_KEY: 'pub-key',
        SLOPDECK_VAPID_PRIVATE_KEY: 'priv-key',
      }),
    ).toThrow(/SLOPDECK_VAPID_SUBJECT/)
  })
})
