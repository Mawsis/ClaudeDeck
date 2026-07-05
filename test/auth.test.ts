import { Hono } from 'hono'
import { describe, expect, it } from 'vitest'
import type { AppEnv } from '../src/gateway/app.ts'
import { requireWorkspace } from '../src/gateway/auth.ts'
import { createWorkspaceStore } from '../src/gateway/workspace-store.ts'

/**
 * requireWorkspace is the boundary that turns a presented key into a workspace
 * id every downstream handler trusts. Wrong-scope is a deliberate 403 (right
 * credential, wrong door) exactly as the old static-token gate behaved; an
 * unknown key is a 401.
 */
function appWith(store = createWorkspaceStore()) {
  const app = new Hono<AppEnv>()
  // Echo the resolved workspace id so a test can prove the middleware stashed
  // the right one on the context.
  app.get('/hook', requireWorkspace('hook', store), (c) =>
    c.json({ workspaceId: c.get('workspaceId') }),
  )
  app.get('/deck', requireWorkspace('deck', store), (c) =>
    c.json({ workspaceId: c.get('workspaceId') }),
  )
  return { app, store }
}

describe('requireWorkspace', () => {
  it('resolves a hook key to its workspace id and stashes it on the context', async () => {
    const { app, store } = appWith()
    const { workspaceId, hookKey } = store.createWorkspace()

    const response = await app.request('/hook', {
      headers: { Authorization: `Bearer ${hookKey}` },
    })

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ workspaceId })
  })

  it('accepts a deck key via ?token= since EventSource cannot set headers', async () => {
    const { app, store } = appWith()
    const { workspaceId, deckKey } = store.createWorkspace()

    const response = await app.request(`/deck?token=${deckKey}`)

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ workspaceId })
  })

  it('rejects a deck key presented at a hook door with 403 — right key, wrong scope', async () => {
    const { app, store } = appWith()
    const { deckKey } = store.createWorkspace()

    const response = await app.request('/hook', {
      headers: { Authorization: `Bearer ${deckKey}` },
    })

    expect(response.status).toBe(403)
  })

  it('rejects an unknown key with 401', async () => {
    const { app, store } = appWith()
    store.createWorkspace()

    const response = await app.request('/hook', {
      headers: { Authorization: 'Bearer 0000000000000000000000000000000000000000000000000000000000000000' },
    })

    expect(response.status).toBe(401)
  })

  it('rejects a request presenting no key with 401', async () => {
    const { app } = appWith()

    const response = await app.request('/hook')

    expect(response.status).toBe(401)
  })

  it('resolves each workspace to only itself — one deck key never opens another workspace', async () => {
    const { app, store } = appWith()
    const a = store.createWorkspace()
    const b = store.createWorkspace()

    const asA = await app.request(`/deck?token=${a.deckKey}`)
    const asB = await app.request(`/deck?token=${b.deckKey}`)

    expect(await asA.json()).toEqual({ workspaceId: a.workspaceId })
    expect(await asB.json()).toEqual({ workspaceId: b.workspaceId })
    expect(a.workspaceId).not.toBe(b.workspaceId)
  })
})
