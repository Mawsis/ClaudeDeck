import { describe, expect, it } from 'vitest'
import { createApp } from '../src/gateway/app.ts'
import { createEventLog } from '../src/gateway/event-log.ts'

const HOOK_TOKEN = 'hook-token-for-tests-0123456789abcdef'
const DECK_TOKEN = 'deck-token-for-tests-0123456789abcdef'

function buildApp() {
  const eventLog = createEventLog()
  const app = createApp({ hookToken: HOOK_TOKEN, deckToken: DECK_TOKEN, eventLog })
  return { app, eventLog }
}

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

  it('rejects a payload without a valid Stop shape with 400', async () => {
    const { app, eventLog } = buildApp()

    const response = await postEvent(app, HOOK_TOKEN, { hook_event_name: 'Stop' })

    expect(response.status).toBe(400)
    expect(eventLog.history()).toHaveLength(0)
  })
})
