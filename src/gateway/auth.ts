import { timingSafeEqual } from 'node:crypto'
import type { Context, MiddlewareHandler } from 'hono'

export type TokenScope = 'hook' | 'deck'

export type AuthTokens = {
  readonly hookToken: string
  readonly deckToken: string
}

function safeEquals(a: string, b: string): boolean {
  const bufA = Buffer.from(a)
  const bufB = Buffer.from(b)
  if (bufA.length !== bufB.length) return false
  return timingSafeEqual(bufA, bufB)
}

function presentedToken(c: Context, scope: TokenScope): string | undefined {
  const header = c.req.header('Authorization')
  if (header?.startsWith('Bearer ')) return header.slice('Bearer '.length)
  // EventSource cannot set headers, so deck-scoped routes also accept ?token=
  if (scope === 'deck') return c.req.query('token') ?? undefined
  return undefined
}

/**
 * Requires the token for `scope`. A valid token of the *other* scope is a
 * deliberate 403 (right credential, wrong door); anything else is a 401.
 */
export function requireScope(scope: TokenScope, tokens: AuthTokens): MiddlewareHandler {
  const expected = scope === 'hook' ? tokens.hookToken : tokens.deckToken
  const other = scope === 'hook' ? tokens.deckToken : tokens.hookToken

  return async (c, next) => {
    const presented = presentedToken(c, scope)
    if (presented === undefined) return c.json({ error: 'missing token' }, 401)
    if (safeEquals(presented, expected)) return next()
    if (safeEquals(presented, other)) return c.json({ error: 'wrong token scope' }, 403)
    return c.json({ error: 'invalid token' }, 401)
  }
}
