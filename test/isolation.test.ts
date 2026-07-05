import { describe, expect, it } from 'vitest'
import { buildWorkspaceApp } from './helpers.ts'

/**
 * The merge gate: workspace A's events must never reach workspace B — not on a
 * live stream, not on Last-Event-ID replay, not in the session count. A leak
 * here is the catastrophic, non-retrofittable failure the whole workspace model
 * exists to prevent, so these tests drive the real HTTP surface end to end.
 */

/** POST a Stop event as a hook, authenticated by a workspace's hook key. */
async function postStop(
  app: Awaited<ReturnType<typeof buildWorkspaceApp>>['app'],
  hookKey: string,
  title: string,
): Promise<Response> {
  return app.request('/api/events', {
    method: 'POST',
    headers: { Authorization: `Bearer ${hookKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ hook_event_name: 'Stop', session_id: `sess-${title}`, cwd: `/w/${title}` }),
  })
}

/** Read one SSE frame off a deck stream opened with a deck key. */
async function openStreamAndRead(
  app: Awaited<ReturnType<typeof buildWorkspaceApp>>['app'],
  deckKey: string,
  lastEventId?: string,
): Promise<{ reader: ReadableStreamDefaultReader<Uint8Array>; read: () => Promise<string> }> {
  const response = await app.request(`/api/stream?token=${deckKey}`, {
    headers: lastEventId === undefined ? {} : { 'Last-Event-ID': lastEventId },
  })
  const reader = response.body!.getReader()
  const decoder = new TextDecoder()
  return { reader, read: async () => decoder.decode((await reader.read()).value) }
}

describe('workspace isolation', () => {
  it("delivers a workspace's event only to its own deck, never another workspace's stream", async () => {
    const { app, store } = buildWorkspaceApp()
    const a = store.createWorkspace()
    const b = store.createWorkspace()

    // Both decks are listening live.
    const deckA = await openStreamAndRead(app, a.deckKey)
    const deckB = await openStreamAndRead(app, b.deckKey)

    // A's hook publishes an event that is A's alone.
    await postStop(app, a.hookKey, 'a-secret-project')

    // A's deck sees it...
    const frameA = await deckA.read()
    expect(frameA).toContain('"title":"a-secret-project"')

    // ...and B's deck must never carry it. Publish into B so B's stream has a
    // frame to read; if isolation leaked, A's title would ride along too.
    await postStop(app, b.hookKey, 'b-own-project')
    const frameB = await deckB.read()
    expect(frameB).toContain('"title":"b-own-project"')
    expect(frameB).not.toContain('a-secret-project')

    await deckA.reader.cancel()
    await deckB.reader.cancel()
  })

  it('replays only the reconnecting workspace\'s ring buffer on Last-Event-ID, never another\'s history', async () => {
    const { app, store } = buildWorkspaceApp()
    const a = store.createWorkspace()
    const b = store.createWorkspace()

    // A accrues history while B is quiet.
    await postStop(app, a.hookKey, 'a-history-one')
    await postStop(app, a.hookKey, 'a-history-two')
    // B has exactly one event of its own.
    await postStop(app, b.hookKey, 'b-history-one')

    // B reconnects from the very beginning: it must replay only its own buffer.
    const deckB = await openStreamAndRead(app, b.deckKey, '0')
    let frames = ''
    while (!frames.includes('b-history-one')) {
      frames += await deckB.read()
    }
    expect(frames).not.toContain('a-history-one')
    expect(frames).not.toContain('a-history-two')

    await deckB.reader.cancel()
  })

  it("refuses to let one workspace's deck resolve another workspace's held permission prompt", async () => {
    const { app, store } = buildWorkspaceApp({ permissionTimeoutMs: 10_000 })
    const a = store.createWorkspace()
    const b = store.createWorkspace()

    // A needs an open deck for the prompt to hold rather than fall back.
    const deckA = await openStreamAndRead(app, a.deckKey)

    // A's hook raises a permission prompt; capture its id off A's stream.
    const held = app.request('/api/permission', {
      method: 'POST',
      headers: { Authorization: `Bearer ${a.hookKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        hook_event_name: 'PermissionRequest',
        session_id: 's1',
        cwd: '/w/a',
        tool_name: 'Bash',
        tool_input: { command: 'ls' },
      }),
    })
    let frames = ''
    while (!frames.includes('"promptId"')) frames += await deckA.read()
    const promptId = /"promptId":"([^"]+)"/.exec(frames)![1]!

    // B, holding only its own deck key, tries to allow A's prompt. Because the
    // prompt id lives only in A's runtime store, B's resolve misses → 404, and
    // A's hook stays held (it did not receive an allow).
    const crossResolve = await app.request(`/api/prompts/${promptId}/resolution`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${b.deckKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'allow' }),
    })
    expect(crossResolve.status).toBe(404)

    // A's own deck can still resolve it — proving the id was valid, just not B's
    // to answer.
    const ownResolve = await app.request(`/api/prompts/${promptId}/resolution`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${a.deckKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'allow' }),
    })
    expect(ownResolve.status).toBe(200)

    const response = await held
    const body = (await response.json()) as { hookSpecificOutput?: { decision?: { behavior: string } } }
    expect(body.hookSpecificOutput?.decision?.behavior).toBe('allow')

    await deckA.reader.cancel()
  })

  it('numbers each workspace\'s events from its own sequence — B\'s first event is id 1 regardless of A\'s traffic', async () => {
    const { app, store } = buildWorkspaceApp()
    const a = store.createWorkspace()
    const b = store.createWorkspace()

    // A burns through several ids first.
    await postStop(app, a.hookKey, 'a-1')
    await postStop(app, a.hookKey, 'a-2')
    await postStop(app, a.hookKey, 'a-3')

    // B's first-ever event replays as id 1 on B's stream — the ring buffer is
    // per-workspace, so ids do not bleed across the boundary.
    await postStop(app, b.hookKey, 'b-1')
    const deckB = await openStreamAndRead(app, b.deckKey, '0')
    let frames = ''
    while (!frames.includes('b-1')) {
      frames += await deckB.read()
    }
    expect(frames).toContain('id: 1')

    await deckB.reader.cancel()
  })
})
