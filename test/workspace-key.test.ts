import { describe, expect, it } from 'vitest'
import { createHash } from 'node:crypto'
import {
  decodeInstall,
  encodeInstall,
  equals,
  generate,
  hash,
  pairingUrl,
} from '../src/gateway/workspace-key.ts'

describe('workspace-key: generate', () => {
  it('mints a 256-bit key as 64 lowercase hex characters', () => {
    const key = generate()

    // 32 bytes = 64 hex chars; the whole surface is [0-9a-f].
    expect(key).toMatch(/^[0-9a-f]{64}$/)
  })

  it('never collides across many generations — every key is unique', () => {
    const keys = new Set(Array.from({ length: 10_000 }, () => generate()))

    // 10k draws from a 256-bit space: a single collision here would signal a
    // broken RNG, not bad luck.
    expect(keys.size).toBe(10_000)
  })
})

describe('workspace-key: hash', () => {
  it('is SHA-256 of the key as hex — the only thing the store ever persists', () => {
    const key = generate()

    const expected = createHash('sha256').update(key).digest('hex')
    expect(hash(key)).toBe(expected)
  })

  it('is deterministic — the same key always hashes to the same digest', () => {
    const key = generate()

    expect(hash(key)).toBe(hash(key))
  })

  it('is a one-way digest — the plaintext key never appears inside its hash', () => {
    const key = generate()

    expect(hash(key)).not.toContain(key)
  })
})

describe('workspace-key: equals', () => {
  it('accepts the key whose hash was stored', () => {
    const key = generate()

    expect(equals(hash(key), key)).toBe(true)
  })

  it('rejects any other key against a stored hash', () => {
    const stored = hash(generate())

    expect(equals(stored, generate())).toBe(false)
  })

  it('rejects a hash of the wrong length without throwing — timing-safe compare needs equal lengths', () => {
    const key = generate()

    // A truncated/garbage stored hash must be a clean `false`, not a crash.
    expect(equals('', key)).toBe(false)
    expect(equals('deadbeef', key)).toBe(false)
  })
})

describe('workspace-key: install blob', () => {
  it('round-trips the gateway url and key through encode/decode', () => {
    const key = generate()

    const decoded = decodeInstall(encodeInstall('https://slopdeck.com', key))

    expect(decoded).toEqual({ gatewayUrl: 'https://slopdeck.com', key })
  })

  it('carries no plaintext on its face — the blob is opaque, not the raw key', () => {
    const key = generate()

    const blob = encodeInstall('https://slopdeck.com', key)

    // Whoever shoulder-surfs the blob can decode it, but it is not the key sitting
    // in the clear — it is a single paste-able token, url-safe (no +, /, =).
    expect(blob).not.toContain(key)
    expect(blob).toMatch(/^[A-Za-z0-9_-]+$/)
  })

  it('returns null for a blob that is not valid base64url json', () => {
    expect(decodeInstall('not a blob!!!')).toBeNull()
  })

  it('returns null when the blob decodes to valid json that is not an object', () => {
    // A well-formed base64url body can still be a scalar or null — the envelope
    // must be an object before we look for its fields.
    const scalar = Buffer.from('42').toString('base64url')
    const nullish = Buffer.from('null').toString('base64url')

    expect(decodeInstall(scalar)).toBeNull()
    expect(decodeInstall(nullish)).toBeNull()
  })

  it('returns null when the decoded key is not a 256-bit hex key', () => {
    const bad = Buffer.from(JSON.stringify({ u: 'https://slopdeck.com', k: 'short' }))
      .toString('base64url')

    // A well-formed envelope carrying a malformed key is still a reject — the
    // codec is a boundary, so it never hands back a key it wouldn't have minted.
    expect(decodeInstall(bad)).toBeNull()
  })

  it('returns null when the gateway url is missing', () => {
    const bad = Buffer.from(JSON.stringify({ k: generate() })).toString('base64url')

    expect(decodeInstall(bad)).toBeNull()
  })
})

describe('workspace-key: pairingUrl', () => {
  it('carries the key in the url fragment so it never reaches the server', () => {
    const key = generate()

    // The `#` fragment is stripped by the browser before any HTTP request, so
    // the key never lands in an access log — the reused pairing mechanism.
    expect(pairingUrl('https://slopdeck.com', key)).toBe(
      `https://slopdeck.com/#deck-token=${key}`,
    )
  })

  it('normalizes a trailing slash so the fragment attaches cleanly', () => {
    const key = generate()

    expect(pairingUrl('https://slopdeck.com/', key)).toBe(
      `https://slopdeck.com/#deck-token=${key}`,
    )
  })
})
