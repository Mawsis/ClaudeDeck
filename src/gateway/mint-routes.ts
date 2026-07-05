import type { Context, Hono } from 'hono'
import type { AppEnv } from './app.ts'
import { createRateLimiter, type RateLimiter } from './rate-limiter.ts'
import type { WorkspaceStore } from './workspace-store.ts'

export type HostedRateLimit = {
  readonly max: number
  readonly windowMs: number
}

export type MintConfig = {
  /**
   * Absent/false → the ungated `/api/mint/local` route is NOT registered (404).
   * The trust boundary for local mint is localhost, so it is opt-in and must be
   * left off for any hosted deployment — a public gateway must never expose an
   * unauthenticated workspace factory behind its TLS.
   */
  readonly local?: boolean
  /** Absent → hosted mint disabled; the endpoint 404s. */
  readonly hostedRateLimit?: HostedRateLimit
}

export type MintRoutesConfig = {
  readonly store: WorkspaceStore
  readonly mint?: MintConfig | undefined
  readonly now?: (() => number) | undefined
}

/**
 * The client IP for rate-limit keying, resolved for the deployed proxy chain.
 *
 * Preference order, most-trustworthy first:
 *  1. `cf-connecting-ip` — Cloudflare's real-client header. slopdeck.mawsis.dev
 *     sits behind Cloudflare → Traefik, and each request egresses from a
 *     DIFFERENT Cloudflare edge IP, so the `x-forwarded-for` right-most hop
 *     rotates per request and can NEVER accumulate a per-client bucket (this is
 *     issue #37: 15 rapid mints all returned 201). `cf-connecting-ip` is the one
 *     value that stays constant for a given client behind Cloudflare.
 *  2. `x-real-ip` — set by many single-proxy setups (nginx/Traefik) to the
 *     direct client.
 *  3. `x-forwarded-for` RIGHT-most hop — the one-trusted-proxy case (e.g. the
 *     old Caddy topology): the proxy APPENDS the address it observed, so the
 *     right-most entry is the real client and the left-most is client-spoofable.
 *
 * Absent all three → a single shared bucket, so a direct/mis-proxied caller
 * fails closed (shared limit) rather than open (unlimited).
 */
function clientIp(c: Context): string {
  const cf = c.req.header('cf-connecting-ip')
  if (cf !== undefined && cf.trim() !== '') return cf.trim()

  const realIp = c.req.header('x-real-ip')
  if (realIp !== undefined && realIp.trim() !== '') return realIp.trim()

  const forwarded = c.req.header('x-forwarded-for')
  if (forwarded === undefined || forwarded === '') return 'unknown'
  const hops = forwarded.split(',').map((hop) => hop.trim()).filter((hop) => hop !== '')
  return hops.length === 0 ? 'unknown' : hops[hops.length - 1]!
}

/**
 * Mint endpoints (D18/D16/D17). Local mint is ungated — localhost is the trust
 * boundary, so `install --local` mints directly. Hosted mint is public and
 * IP-rate-limited; the workspaces it produces are ephemeral until an account
 * claims them, and `deleteExpired` sweeps the abandoned ones.
 */
export function registerMintRoutes(app: Hono<AppEnv>, config: MintRoutesConfig): void {
  const { store } = config

  // Local mint is registered ONLY in local mode — otherwise the route is absent
  // (404), so a hosted gateway never carries an ungated workspace factory.
  if (config.mint?.local === true) {
    app.post('/api/mint/local', (c) => {
      const workspace = store.createWorkspace()
      return c.json(workspace, 201)
    })
  }

  const hostedLimit = config.mint?.hostedRateLimit
  if (hostedLimit !== undefined) {
    const limiter: RateLimiter = createRateLimiter({
      max: hostedLimit.max,
      windowMs: hostedLimit.windowMs,
      ...(config.now ? { now: config.now } : {}),
    })

    app.post('/api/mint/hosted', (c) => {
      if (!limiter.take(clientIp(c))) {
        return c.json({ error: 'rate limit exceeded — try again later' }, 429)
      }
      const workspace = store.createWorkspace()
      return c.json(workspace, 201)
    })
  }
}
