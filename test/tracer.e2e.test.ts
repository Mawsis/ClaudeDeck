import { serve } from '@hono/node-server'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { buildApp, DECK_TOKEN, HOOK_TOKEN } from './helpers.ts'

let server: ReturnType<typeof serve>
let baseUrl: string

beforeAll(async () => {
  const { app } = buildApp()
  await new Promise<void>((resolve) => {
    server = serve({ fetch: app.fetch, port: 0 }, (info) => {
      baseUrl = `http://127.0.0.1:${info.port}`
      resolve()
    })
  })
})

afterAll(() => {
  server.close()
})

describe('tracer: Stop hook to deck', () => {
  it('delivers a POSTed Stop payload to a connected SSE client within 1s, labeled with the cwd basename', async () => {
    const controller = new AbortController()
    const streamResponse = await fetch(`${baseUrl}/api/stream?token=${DECK_TOKEN}`, {
      signal: controller.signal,
    })
    expect(streamResponse.status).toBe(200)
    const reader = streamResponse.body!.getReader()

    const postedAt = Date.now()
    const ingestResponse = await fetch(`${baseUrl}/api/events`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${HOOK_TOKEN}`,
      },
      body: JSON.stringify({
        hook_event_name: 'Stop',
        session_id: 'sess-e2e',
        cwd: '/Users/mac/Workshop/Personal/my-app',
      }),
    })
    expect(ingestResponse.status).toBe(202)

    const { value } = await reader.read()
    const elapsed = Date.now() - postedAt
    const frame = new TextDecoder().decode(value)

    expect(frame).toContain('event: stop')
    expect(frame).toContain('"title":"my-app"')
    expect(elapsed).toBeLessThan(1000)

    controller.abort()
  })
})
