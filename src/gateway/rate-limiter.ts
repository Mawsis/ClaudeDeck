/**
 * A per-key sliding-window rate limiter, in memory. `take(key)` records one hit
 * and returns whether it is allowed: at most `max` hits per key within any
 * `windowMs` window. Hosted mint uses it keyed by client IP so a bot cannot
 * mint thousands of ephemeral workspaces. Process-local by design — the hosted
 * gateway is one process; a distributed limiter is an accounts-layer concern.
 */
export type RateLimiter = {
  /** Records a hit for `key`; true if within the limit, false if it should be rejected. */
  take(key: string): boolean
}

export type RateLimiterOptions = {
  readonly max: number
  readonly windowMs: number
  /** Injectable clock for deterministic window tests. */
  readonly now?: () => number
}

export function createRateLimiter(options: RateLimiterOptions): RateLimiter {
  const { max, windowMs } = options
  const now = options.now ?? Date.now
  // key → hit timestamps still inside the current window, oldest first.
  const hits = new Map<string, number[]>()

  return {
    take(key) {
      const cutoff = now() - windowMs
      // Drop timestamps that have aged out of the window before counting, so a
      // long-idle key never carries stale hits forward.
      const recent = (hits.get(key) ?? []).filter((at) => at > cutoff)
      if (recent.length >= max) {
        hits.set(key, recent)
        return false
      }
      recent.push(now())
      hits.set(key, recent)
      return true
    },
  }
}
