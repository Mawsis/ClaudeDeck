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
 * The client IP behind the hosted reverse proxy, for rate-limit keying. The
 * shipped topology is exactly one trusted proxy (Caddy), which APPENDS the
 * address it observed to `x-forwarded-for`. So the trustworthy client address
 * is the RIGHT-most entry — the hop nearest us — NOT the left-most, which is
 * whatever the client typed and can rotate per request to dodge the limit.
 * Absent header → a single shared bucket, so a direct/mis-proxied caller fails
 * closed (shared limit) rather than open (unlimited).
 */
function clientIp(c: Context): string {
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
