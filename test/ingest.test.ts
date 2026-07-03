import { describe, expect, it } from 'vitest'
import { buildApp, DECK_TOKEN, HOOK_TOKEN } from './helpers.ts'

const stopPayload = {
  hook_event_name: 'Stop',
  session_id: 'sess-42',
  cwd: '/Users/mac/Workshop/Personal/my-app',
}

function postEvent(app: ReturnType<typeof buildApp>['app'], token: string | undefined, body: unknown) {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' }
  if (token !== undefined) headers.Authorization = `Bearer ${token}`
  return app.request('/api/events', { method: 'POST', headers, body: JSON.stringify(body) })
}

describe('event ingest', () => {
  it('accepts a Stop payload with a valid hook token and publishes it labeled with the cwd basename', async () => {
    const { app, eventLog } = buildApp()

    const response = await postEvent(app, HOOK_TOKEN, stopPayload)

    expect(response.status).toBe(202)
    const events = eventLog.history()
    expect(events).toHaveLength(1)
    expect(events[0]).toMatchObject({ type: 'stop', sessionId: 'sess-42', title: 'my-app' })
  })

  it('rejects a missing token with 401 and publishes nothing', async () => {
    const { app, eventLog } = buildApp()

    const response = await postEvent(app, undefined, stopPayload)

    expect(response.status).toBe(401)
    expect(eventLog.history()).toHaveLength(0)
  })

  it('rejects an unknown token with 401', async () => {
    const { app, eventLog } = buildApp()

    const response = await postEvent(app, 'not-a-real-token', stopPayload)

    expect(response.status).toBe(401)
    expect(eventLog.history()).toHaveLength(0)
  })

  it('rejects the deck token on ingest — wrong scope', async () => {
    const { app, eventLog } = buildApp()

    const response = await postEvent(app, DECK_TOKEN, stopPayload)

    expect(response.status).toBe(403)
    expect(eventLog.history()).toHaveLength(0)
  })

  it('clamps pathological cwd basenames to a bounded title length', async () => {
    const { app, eventLog } = buildApp()

    const response = await postEvent(app, HOOK_TOKEN, {
      ...stopPayload,
      cwd: `/tmp/${'x'.repeat(5000)}`,
    })

    expect(response.status).toBe(202)
    expect(eventLog.history()[0]!.title.length).toBeLessThanOrEqual(120)
  })

  it('rejects a payload without a valid Stop shape with 400', async () => {
    const { app, eventLog } = buildApp()

    const response = await postEvent(app, HOOK_TOKEN, { hook_event_name: 'Stop' })

    expect(response.status).toBe(400)
    expect(eventLog.history()).toHaveLength(0)
  })

  it('accepts a UserPromptSubmit payload and publishes it as a prompt event', async () => {
    const { app, eventLog } = buildApp()

    const response = await postEvent(app, HOOK_TOKEN, {
      hook_event_name: 'UserPromptSubmit',
      session_id: 'sess-42',
      cwd: '/Users/mac/Workshop/Personal/my-app',
    })

    expect(response.status).toBe(202)
    const events = eventLog.history()
    expect(events).toHaveLength(1)
    expect(events[0]).toMatchObject({ type: 'prompt', sessionId: 'sess-42', title: 'my-app' })
  })

  it('rejects hook event names outside Stop and UserPromptSubmit with 400', async () => {
    const { app, eventLog } = buildApp()

    const response = await postEvent(app, HOOK_TOKEN, {
      hook_event_name: 'SubagentStop',
      session_id: 'sess-42',
      cwd: '/tmp/app',
    })

    expect(response.status).toBe(400)
    expect(eventLog.history()).toHaveLength(0)
  })
})
