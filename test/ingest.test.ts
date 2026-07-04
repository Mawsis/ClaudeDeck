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
    // A stop event carries a title; the union now also spans title-less mode
    // events, so narrow before reaching for it.
    const event = eventLog.history()[0]! as { title: string }
    expect(event.title.length).toBeLessThanOrEqual(120)
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

  it('accepts a Handshake payload and publishes it as a handshake event — the proof-of-pipeline ping', async () => {
    const { app, eventLog } = buildApp()

    const response = await postEvent(app, HOOK_TOKEN, {
      hook_event_name: 'Handshake',
      session_id: 'install-1',
      cwd: '/Users/mac/Workshop/Personal/my-app',
    })

    expect(response.status).toBe(202)
    const events = eventLog.history()
    expect(events).toHaveLength(1)
    expect(events[0]).toMatchObject({ type: 'handshake', sessionId: 'install-1', title: 'my-app' })
  })

  it('rejects an unauthenticated Handshake exactly like every other hook post', async () => {
    const { app, eventLog } = buildApp()

    const handshake = {
      hook_event_name: 'Handshake',
      session_id: 'install-1',
      cwd: '/tmp/app',
    }
    expect((await postEvent(app, undefined, handshake)).status).toBe(401)
    expect((await postEvent(app, DECK_TOKEN, handshake)).status).toBe(403)
    expect(eventLog.history()).toHaveLength(0)
  })

  it('rejects hook event names outside the supported set with 400', async () => {
    const { app, eventLog } = buildApp()

    const response = await postEvent(app, HOOK_TOKEN, {
      hook_event_name: 'SubagentStop',
      session_id: 'sess-42',
      cwd: '/tmp/app',
    })

    expect(response.status).toBe(400)
    expect(eventLog.history()).toHaveLength(0)
  })

  it('publishes a PostToolUse Bash payload as a tool event classified by its command', async () => {
    const { app, eventLog } = buildApp()

    const response = await postEvent(app, HOOK_TOKEN, {
      hook_event_name: 'PostToolUse',
      session_id: 'sess-42',
      cwd: '/Users/mac/Workshop/Personal/my-app',
      tool_name: 'Bash',
      tool_input: { command: 'npm install hono' },
    })

    expect(response.status).toBe(202)
    expect(eventLog.history()[0]).toMatchObject({
      type: 'tool',
      sessionId: 'sess-42',
      title: 'my-app',
      tool: 'Bash',
      detail: 'npm install hono',
      category: 'package-install',
      risk: 'highlighted',
    })
  })

  it('publishes an Edit as a routine row detailed with the file path relative to the cwd', async () => {
    const { app, eventLog } = buildApp()

    const response = await postEvent(app, HOOK_TOKEN, {
      hook_event_name: 'PostToolUse',
      session_id: 'sess-42',
      cwd: '/Users/mac/Workshop/Personal/my-app',
      tool_name: 'Edit',
      tool_input: { file_path: '/Users/mac/Workshop/Personal/my-app/src/gateway/app.ts' },
    })

    expect(response.status).toBe(202)
    expect(eventLog.history()[0]).toMatchObject({
      type: 'tool',
      tool: 'Edit',
      detail: 'src/gateway/app.ts',
      category: 'edit',
      risk: 'routine',
    })
  })

  it('rejects a PostToolUse payload without a tool_name with 400', async () => {
    const { app, eventLog } = buildApp()

    const response = await postEvent(app, HOOK_TOKEN, {
      hook_event_name: 'PostToolUse',
      session_id: 'sess-42',
      cwd: '/tmp/app',
      tool_input: { command: 'ls' },
    })

    expect(response.status).toBe(400)
    expect(eventLog.history()).toHaveLength(0)
  })

  it('clamps a pathological command to a bounded detail but classifies the full string', async () => {
    const { app, eventLog } = buildApp()

    const response = await postEvent(app, HOOK_TOKEN, {
      hook_event_name: 'PostToolUse',
      session_id: 'sess-42',
      cwd: '/tmp/app',
      tool_name: 'Bash',
      // The high-impact part sits beyond the clamp — the highlight must not
      // be truncated away with the display text.
      tool_input: { command: `echo ${'x'.repeat(400)} && git push --force` },
    })

    expect(response.status).toBe(202)
    const event = eventLog.history()[0]!
    expect(event).toMatchObject({ type: 'tool', category: 'force-push', risk: 'high' })
    if (event.type === 'tool') expect(event.detail.length).toBeLessThanOrEqual(200)
  })

  it('never clamps mid-character — an astral glyph at the boundary is dropped whole, not split', async () => {
    const { app, eventLog } = buildApp()

    const response = await postEvent(app, HOOK_TOKEN, {
      hook_event_name: 'PostToolUse',
      session_id: 'sess-42',
      cwd: '/tmp/app',
      tool_name: 'Bash',
      // '🚀' is two UTF-16 code units; placed to straddle the 200-unit clamp.
      tool_input: { command: `echo ${'x'.repeat(194)}🚀🚀🚀` },
    })

    expect(response.status).toBe(202)
    const event = eventLog.history()[0]!
    if (event.type === 'tool') {
      // A lone surrogate at the end would render as a broken glyph (D13).
      expect(event.detail).not.toMatch(/[\uD800-\uDBFF]$/)
    }
  })
})
