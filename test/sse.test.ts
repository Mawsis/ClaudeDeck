import { describe, expect, it } from 'vitest'
import { buildApp, DECK_TOKEN, HOOK_TOKEN } from './helpers.ts'

describe('SSE stream', () => {
  it('streams published events to a deck-token client as SSE frames with ids', async () => {
    const { app, eventLog } = buildApp()

    const response = await app.request(`/api/stream?token=${DECK_TOKEN}`)
    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toContain('text/event-stream')

    const reader = response.body!.getReader()
    eventLog.publish({ type: 'stop', sessionId: 'sess-42', title: 'my-app', cwd: '/w/my-app' })

    const { value } = await reader.read()
    const frame = new TextDecoder().decode(value)
    expect(frame).toContain('id: 1')
    expect(frame).toContain('event: stop')
    expect(frame).toContain('"title":"my-app"')
    await reader.cancel()
  })

  it('rejects the hook token on the stream — wrong scope', async () => {
    const { app } = buildApp()

    const response = await app.request(`/api/stream?token=${HOOK_TOKEN}`)

    expect(response.status).toBe(403)
  })

  it('rejects a stream request with no token', async () => {
    const { app } = buildApp()

    const response = await app.request('/api/stream')

    expect(response.status).toBe(401)
  })
})
