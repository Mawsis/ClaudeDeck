import { describe, expect, it } from 'vitest'
import { createApp } from '../src/gateway/app.ts'
import { createWorkspaceStore } from '../src/gateway/workspace-store.ts'

/**
 * Ephemeral hosted workspaces self-clean: one that goes idle past the
 * inactivity cutoff is swept, but activity through the live HTTP surface
 * (ingest, stream) refreshes last_seen and rescues it. These prove the app
 * actually wires activity into the store — the store's own expiry logic is
 * covered in workspace-store.test.ts.
 */
function appAt(now: () => number) {
  const store = createWorkspaceStore({ now })
  const built = createApp({ workspaceStore: store, now, mint: { local: true } })
  return { app: built.app, store, sweepExpired: built.sweepExpired }
}

describe('ephemeral workspace sweep', () => {
  it('sweeps an anonymous workspace that never saw activity past the cutoff', async () => {
    let clock = 1_000
    const { app, store } = appAt(() => clock)

    const minted = (await (await app.request('/api/mint/local', { method: 'POST' })).json()) as {
      workspaceId: string
      deckKey: string
    }

    // Time passes with no activity; the sweep cutoff moves past mint time.
    clock = 100_000
    const removed = store.deleteExpired(50_000)

    expect(removed).toBe(1)
    expect(store.authenticateScoped(minted.deckKey)).toBeNull()
  })

  it('evicts a swept workspace\'s in-memory runtime so it does not leak past its store row', async () => {
    let clock = 1_000
    const { app, store, sweepExpired } = appAt(() => clock)

    // Mint and touch a workspace's runtime into existence by opening its stream.
    const minted = (await (await app.request('/api/mint/local', { method: 'POST' })).json()) as {
      workspaceId: string
      hookKey: string
    }
    await app.request('/api/events', {
      method: 'POST',
      headers: { Authorization: `Bearer ${minted.hookKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ hook_event_name: 'Stop', session_id: 's1', cwd: '/w/ephemeral' }),
    })

    // The app-level sweep removes the store row AND reports the evicted runtime,
    // so the process does not accumulate runtimes for workspaces that no longer
    // exist. It returns the swept ids.
    clock = 100_000
    const swept = sweepExpired(50_000)

    expect(swept).toContain(minted.workspaceId)
    expect(store.authenticateScoped(minted.hookKey)).toBeNull()
  })

  it('spares a workspace whose hook posted an event — ingest refreshes last_seen', async () => {
    let clock = 1_000
    const { app, store } = appAt(() => clock)

    const minted = (await (await app.request('/api/mint/local', { method: 'POST' })).json()) as {
      workspaceId: string
      hookKey: string
      deckKey: string
    }

    // Activity at a later time bumps last_seen past the cutoff.
    clock = 60_000
    const posted = await app.request('/api/events', {
      method: 'POST',
      headers: { Authorization: `Bearer ${minted.hookKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ hook_event_name: 'Stop', session_id: 's1', cwd: '/w/active' }),
    })
    expect(posted.status).toBe(202)

    // A sweep with a cutoff between mint and the event leaves the active one.
    const removed = store.deleteExpired(50_000)
    expect(removed).toBe(0)
    expect(store.authenticateScoped(minted.deckKey)).toEqual({
      workspaceId: minted.workspaceId,
      scope: 'deck',
    })
  })
})
