import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'

const KEY_PATTERN = /^[0-9a-f]{64}$/

/** True for the exact shape `generate()` mints: 64 lowercase hex chars. */
function isKey(value: unknown): value is string {
  return typeof value === 'string' && KEY_PATTERN.test(value)
}

/**
 * A workspace key is a 256-bit random token, carried everywhere as 64 lowercase
 * hex characters — it rides a URL fragment, a `.zshrc` line, a config file, and
 * a QR module as plain text, so hex (not raw bytes) is its native form.
 */
export function generate(): string {
  return randomBytes(32).toString('hex')
}

/**
 * The only representation of a key that touches disk. SHA-256 (not bcrypt/argon2)
 * by decision: a 256-bit random token is unguessable, so a slow hash would only
 * add latency to every reconnect and buy no security.
 */
export function hash(key: string): string {
  return createHash('sha256').update(key).digest('hex')
}

/**
 * Timing-safe check that `key` is the one behind `storedHash`. We hash the
 * presented key and compare digests (always 32 bytes) rather than comparing the
 * keys directly, so a length mismatch in `storedHash` is a plain `false`, never
 * a throw from `timingSafeEqual`'s equal-length requirement.
 */
export function equals(storedHash: string, key: string): boolean {
  const a = Buffer.from(storedHash, 'hex')
  const b = Buffer.from(hash(key), 'hex')
  if (a.length !== b.length) return false
  return timingSafeEqual(a, b)
}

export type Install = {
  readonly gatewayUrl: string
  readonly key: string
}

/**
 * The single paste-able token that carries a fresh install: the gateway URL and
 * the workspace key, as base64url JSON `{u, k}`. url-safe so it survives a QR,
 * a shell arg, or a clipboard without escaping. Not encryption — a shoulder-surfer
 * can decode it — just one opaque blob instead of two fields typed by hand.
 */
export function encodeInstall(gatewayUrl: string, key: string): string {
  return Buffer.from(JSON.stringify({ u: gatewayUrl, k: key })).toString('base64url')
}

/**
 * Inverse of `encodeInstall`, hardened as a trust boundary: any malformed blob,
 * non-JSON body, missing URL, or key that isn't the exact 256-bit hex shape
 * yields `null` — the codec never hands back a key it would not have minted.
 */
export function decodeInstall(blob: string): Install | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(Buffer.from(blob, 'base64url').toString('utf8'))
  } catch {
    return null
  }
  if (typeof parsed !== 'object' || parsed === null) return null
  const { u, k } = parsed as Record<string, unknown>
  if (typeof u !== 'string' || u === '') return null
  if (!isKey(k)) return null
  return { gatewayUrl: u, key: k }
}

/**
 * The phone-pairing URL: the key rides the `#` fragment, which the browser
 * strips before every HTTP request, so it never appears in an access log. This
 * reuses the existing deck-token pairing mechanism — the token is now a
 * per-workspace key rather than one global deck token.
 */
export function pairingUrl(gatewayUrl: string, key: string): string {
  return `${gatewayUrl.replace(/\/+$/, '')}/#deck-token=${encodeURIComponent(key)}`
}
