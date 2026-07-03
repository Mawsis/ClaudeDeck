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

  it('catches up after a network blip: a Stop missed while offline arrives on reconnect', async () => {
    const postEvent = (hookEventName: string, sessionId: string, cwd: string) =>
      fetch(`${baseUrl}/api/events`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${HOOK_TOKEN}`,
        },
        body: JSON.stringify({ hook_event_name: hookEventName, session_id: sessionId, cwd }),
      })

    // Connected deck sees the prompt land.
    const first = new AbortController()
    const firstStream = await fetch(`${baseUrl}/api/stream?token=${DECK_TOKEN}`, {
      signal: first.signal,
    })
    const firstReader = firstStream.body!.getReader()
    await postEvent('UserPromptSubmit', 'sess-blip', '/w/blip-app')
    const seenFrame = new TextDecoder().decode((await firstReader.read()).value)
    const lastSeenId = /id: (\d+)/.exec(seenFrame)![1]

    // Network blip: the deck drops; the session stops while nobody is listening.
    first.abort()
    await postEvent('Stop', 'sess-blip', '/w/blip-app')

    // EventSource reconnects with the last seen id — the missed Stop arrives.
    const second = new AbortController()
    const secondStream = await fetch(`${baseUrl}/api/stream?token=${DECK_TOKEN}`, {
      headers: { 'Last-Event-ID': lastSeenId! },
      signal: second.signal,
    })
    const secondReader = secondStream.body!.getReader()
    const catchUpFrame = new TextDecoder().decode((await secondReader.read()).value)

    expect(catchUpFrame).toContain('event: stop')
    expect(catchUpFrame).toContain('"sessionId":"sess-blip"')
    second.abort()
  })
})

describe('tracer: activity ticker', () => {
  it('delivers a PostToolUse Bash payload to a connected deck within 1s, correctly highlighted', async () => {
    const controller = new AbortController()
    const streamResponse = await fetch(`${baseUrl}/api/stream?token=${DECK_TOKEN}`, {
      signal: controller.signal,
    })
    const reader = streamResponse.body!.getReader()

    const postedAt = Date.now()
    const ingestResponse = await fetch(`${baseUrl}/api/events`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${HOOK_TOKEN}`,
      },
      body: JSON.stringify({
        hook_event_name: 'PostToolUse',
        session_id: 'sess-e2e',
        cwd: '/Users/mac/Workshop/Personal/my-app',
        tool_name: 'Bash',
        tool_input: { command: 'docker compose up -d --build' },
      }),
    })
    expect(ingestResponse.status).toBe(202)

    const { value } = await reader.read()
    const elapsed = Date.now() - postedAt
    const frame = new TextDecoder().decode(value)

    expect(frame).toContain('event: tool')
    expect(frame).toContain('"detail":"docker compose up -d --build"')
    expect(frame).toContain('"risk":"highlighted"')
    expect(elapsed).toBeLessThan(1000)

    controller.abort()
  })

  it('survives a gateway restart: a deck holding a stale Last-Event-ID still receives new live events', async () => {
    // A restarted gateway has an empty log and ids starting over from 1 —
    // history is lost by design, but the deck must keep receiving.
    const { app: restartedApp } = buildApp()
    let restarted!: ReturnType<typeof serve>
    const restartedUrl = await new Promise<string>((resolve) => {
      restarted = serve({ fetch: restartedApp.fetch, port: 0 }, (info) =>
        resolve(`http://127.0.0.1:${info.port}`),
      )
    })

    try {
      const controller = new AbortController()
      const streamResponse = await fetch(`${restartedUrl}/api/stream?token=${DECK_TOKEN}`, {
        headers: { 'Last-Event-ID': '9999' },
        signal: controller.signal,
      })
      const reader = streamResponse.body!.getReader()

      const ingestResponse = await fetch(`${restartedUrl}/api/events`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${HOOK_TOKEN}`,
        },
        body: JSON.stringify({
          hook_event_name: 'PostToolUse',
          session_id: 'sess-restart',
          cwd: '/w/restart-app',
          tool_name: 'Edit',
          tool_input: { file_path: '/w/restart-app/src/index.ts' },
        }),
      })
      expect(ingestResponse.status).toBe(202)

      const frame = new TextDecoder().decode((await reader.read()).value)
      expect(frame).toContain('event: tool')
      expect(frame).toContain('"sessionId":"sess-restart"')

      controller.abort()
    } finally {
      restarted.close()
    }
  })
})
