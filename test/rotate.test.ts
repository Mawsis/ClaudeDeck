import { describe, expect, it } from 'vitest'
import { createApp } from '../src/gateway/app.ts'
import { createWorkspaceStore } from '../src/gateway/workspace-store.ts'

/**
 * POST /api/rotate re-inscribes a workspace: presenting either current key
 * mints a fresh hook+deck pair and invalidates both old keys. Holding the key
 * IS the auth (no account) — this is how a user whose QR or .zshrc leaked
 * re-keys in one command.
 */
function rotateApp() {
  const store = createWorkspaceStore()
  const { app } = createApp({ workspaceStore: store })
  return { app, store }
}

describe('POST /api/rotate', () => {
  it('rotates with the deck key and returns a fresh hook+deck pair for the same workspace', async () => {
    const { app, store } = rotateApp()
    const { workspaceId, hookKey, deckKey } = store.createWorkspace()

    const response = await app.request('/api/rotate', {
      method: 'POST',
      headers: { Authorization: `Bearer ${deckKey}` },
    })

    expect(response.status).toBe(200)
    const body = (await response.json()) as { hookKey: string; deckKey: string }
    expect(body.hookKey).not.toBe(hookKey)
    expect(body.deckKey).not.toBe(deckKey)
    expect(store.authenticateScoped(body.hookKey)).toEqual({ workspaceId, scope: 'hook' })
    expect(store.authenticateScoped(body.deckKey)).toEqual({ workspaceId, scope: 'deck' })
  })

  it('rotates with the hook key too — either key proves ownership', async () => {
    const { app, store } = rotateApp()
    const { workspaceId, hookKey } = store.createWorkspace()

    const response = await app.request('/api/rotate', {
      method: 'POST',
      headers: { Authorization: `Bearer ${hookKey}` },
    })

    expect(response.status).toBe(200)
    const body = (await response.json()) as { deckKey: string }
    expect(store.authenticateScoped(body.deckKey)).toEqual({ workspaceId, scope: 'deck' })
  })

  it('kills both old keys — the leaked QR and the committed .zshrc both stop authenticating', async () => {
    const { app, store } = rotateApp()
    const { hookKey, deckKey } = store.createWorkspace()

    await app.request('/api/rotate', {
      method: 'POST',
      headers: { Authorization: `Bearer ${deckKey}` },
    })

    expect(store.authenticateScoped(hookKey)).toBeNull()
    expect(store.authenticateScoped(deckKey)).toBeNull()
  })

  it('rejects an unknown key with 401 and mints nothing', async () => {
    const { app } = rotateApp()

    const response = await app.request('/api/rotate', {
      method: 'POST',
      headers: { Authorization: 'Bearer 0000000000000000000000000000000000000000000000000000000000000000' },
    })

    expect(response.status).toBe(401)
  })

  it('rejects a request with no key', async () => {
    const { app } = rotateApp()

    const response = await app.request('/api/rotate', { method: 'POST' })

    expect(response.status).toBe(401)
  })
})
