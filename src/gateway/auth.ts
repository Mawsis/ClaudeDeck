import { timingSafeEqual } from 'node:crypto'
import type { Context, MiddlewareHandler } from 'hono'

export type TokenScope = 'hook' | 'deck'

/** The workspace id a valid key resolved to, stashed for every downstream handler. */
export type WorkspaceVariables = {
  workspaceId: string
}

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

/** The slice of the store the auth layer needs: key → scoped identity. */
export type ScopeResolver = {
  authenticateScoped(key: string): { readonly workspaceId: string; readonly scope: TokenScope } | null
}

/**
 * The workspace-scoped gate: a presented key is resolved against the store to a
 * `{ workspaceId, scope }`, the id is stashed on the context for downstream
 * handlers, and scope is enforced with the same wrong-door semantics as
 * `requireScope` — a valid key of the *other* scope is a 403, an unknown key is
 * a 401. This replaces the two global static tokens with per-workspace keys.
 */
export function requireWorkspace(scope: TokenScope, store: ScopeResolver): MiddlewareHandler {
  return async (c, next) => {
    const presented = presentedToken(c, scope)
    if (presented === undefined) return c.json({ error: 'missing token' }, 401)
    const identity = store.authenticateScoped(presented)
    if (identity === null) return c.json({ error: 'invalid token' }, 401)
    if (identity.scope !== scope) return c.json({ error: 'wrong token scope' }, 403)
    c.set('workspaceId', identity.workspaceId)
    return next()
  }
}

/**
 * Scope-agnostic gate for operations where holding *either* of a workspace's
 * keys is the proof of ownership — rotation, above all. Any valid key (hook or
 * deck, Bearer header only) resolves and stashes its workspace id; anything else
 * is a 401. There is no wrong-door here by design: both keys are the same
 * workspace's, so neither is "the wrong scope" for proving you own it.
 */
export function requireAnyKey(store: ScopeResolver): MiddlewareHandler {
  return async (c, next) => {
    const header = c.req.header('Authorization')
    const presented = header?.startsWith('Bearer ') ? header.slice('Bearer '.length) : undefined
    if (presented === undefined) return c.json({ error: 'missing token' }, 401)
    const identity = store.authenticateScoped(presented)
    if (identity === null) return c.json({ error: 'invalid token' }, 401)
    c.set('workspaceId', identity.workspaceId)
    return next()
  }
}
