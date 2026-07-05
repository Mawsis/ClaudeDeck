import { describe, expect, it, vi } from 'vitest'
import { buildApp, DECK_TOKEN, HOOK_TOKEN } from './helpers.ts'

/** Opens a deck SSE stream and reads frames until `predicate` matches. */
async function openDeck(app: ReturnType<typeof buildApp>['app']) {
  const response = await app.request(`/api/stream?token=${DECK_TOKEN}`)
  const reader = response.body!.getReader()
  const decoder = new TextDecoder()
  let buffered = ''
  return {
    async readUntil(marker: string) {
      while (!buffered.includes(marker)) {
        buffered += decoder.decode((await reader.read()).value)
      }
      return buffered
    },
    close: () => reader.cancel(),
  }
}

const resolvePrompt = (
  app: ReturnType<typeof buildApp>['app'],
  promptId: string,
  action: string,
) =>
  app.request(`/api/prompts/${promptId}/resolution`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${DECK_TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ action }),
  })

const togglePause = (app: ReturnType<typeof buildApp>['app'], token = DECK_TOKEN) =>
  app.request('/api/pause', {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: '{}',
  })

const permissionPayload = (overrides: Record<string, unknown> = {}) => ({
  hook_event_name: 'PermissionRequest',
  session_id: 'sess-7',
  cwd: '/w/my-app',
  tool_name: 'Bash',
  tool_input: { command: 'rm -rf build' },
  ...overrides,
})

const postPermission = (
  app: ReturnType<typeof buildApp>['app'],
  payload: unknown = permissionPayload(),
) =>
  app.request('/api/permission', {
    method: 'POST',
    headers: { Authorization: `Bearer ${HOOK_TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  })

describe('permission hold contract', () => {
  it('answers immediately with the no-decision shape when no deck is connected', async () => {
    const { app } = buildApp()

    const response = await postPermission(app)

    expect(response.status).toBe(200)
    // {} is the documented "no decision" — the terminal dialog proceeds.
    expect(await response.json()).toEqual({})
  })

  it('holds the hook, streams the prompt to the deck, and an Allow tap answers with the documented decision', async () => {
    const { app } = buildApp()
    const deck = await openDeck(app)

    const hookResponse = postPermission(app)

    // The deck sees the prompt: tool name plus the exact command payload.
    const frames = await deck.readUntil('event: permission')
    expect(frames).toContain('"tool":"Bash"')
    expect(frames).toContain('"detail":"rm -rf build"')
    expect(frames).toContain('"title":"my-app"')
    const promptId = /"promptId":"([^"]+)"/.exec(frames)![1]!

    const resolution = await resolvePrompt(app, promptId, 'allow')
    expect(resolution.status).toBe(200)
    expect(await resolution.json()).toEqual({ ok: true })

    const response = await hookResponse
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({
      hookSpecificOutput: {
        hookEventName: 'PermissionRequest',
        decision: { behavior: 'allow' },
      },
    })
    await deck.close()
  })

  it('answers a Deny tap with the documented deny decision', async () => {
    const { app } = buildApp()
    const deck = await openDeck(app)

    const hookResponse = postPermission(app)
    const promptId = /"promptId":"([^"]+)"/.exec(await deck.readUntil('event: permission'))![1]!
    await resolvePrompt(app, promptId, 'deny')

    expect(await (await hookResponse).json()).toEqual({
      hookSpecificOutput: {
        hookEventName: 'PermissionRequest',
        decision: { behavior: 'deny' },
      },
    })
    await deck.close()
  })

  it('answers an Ask-in-terminal tap with the no-decision shape — the terminal dialog proceeds', async () => {
    const { app } = buildApp()
    const deck = await openDeck(app)

    const hookResponse = postPermission(app)
    const promptId = /"promptId":"([^"]+)"/.exec(await deck.readUntil('event: permission'))![1]!
    const resolution = await resolvePrompt(app, promptId, 'ask')

    expect(resolution.status).toBe(200)
    expect(await (await hookResponse).json()).toEqual({})
    await deck.close()
  })

  it('clears the deck card when the hook request aborts — the prompt was answered at the terminal', async () => {
    const { app } = buildApp()
    const deck = await openDeck(app)

    // Claude Code races its own terminal dialog against the http hook. Answering
    // at the terminal makes Claude abort the in-flight hook request — the
    // gateway must notice the disconnect and tell the deck the card is resolved,
    // or the deck stays stuck on an already-answered question.
    const controller = new AbortController()
    const hookResponse = app.request('/api/permission', {
      method: 'POST',
      headers: { Authorization: `Bearer ${HOOK_TOKEN}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(permissionPayload()),
      signal: controller.signal,
    })

    const frames = await deck.readUntil('event: permission')
    const promptId = /"promptId":"([^"]+)"/.exec(frames)![1]!

    // The user answers in the terminal → Claude aborts the hook connection.
    controller.abort()
    await Promise.resolve(hookResponse).catch(() => {}) // the aborted fetch rejects; that's expected.

    // The deck must be told the card is done, keyed on the same promptId.
    const resolved = await deck.readUntil('event: permission-resolved')
    expect(resolved).toContain(`"promptId":"${promptId}"`)
    await deck.close()
  })

  it('answers with the no-decision shape when a connected deck stays silent past the timeout', async () => {
    const { app } = buildApp({ permissionTimeoutMs: 30 })
    const deck = await openDeck(app)

    const response = await postPermission(app)

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({})
    await deck.close()
  })

  it('holds two simultaneous prompts from different sessions — streamed in arrival order, each labeled, each answered on its own hook', async () => {
    const { app } = buildApp()
    const deck = await openDeck(app)

    const firstHook = postPermission(app, permissionPayload({ session_id: 'sess-a' }))
    await deck.readUntil('"sessionId":"sess-a"')
    const secondHook = postPermission(
      app,
      permissionPayload({ session_id: 'sess-b', tool_input: { command: 'git push --force' } }),
    )
    const frames = await deck.readUntil('"sessionId":"sess-b"')

    // Arrival order on the stream is the deck's queue order, each frame
    // carrying its session label.
    const held = [...frames.matchAll(/"sessionId":"(sess-[ab])".*?"promptId":"([^"]+)"/g)].map(
      ([, sessionId, promptId]) => ({ sessionId, promptId }),
    )
    expect(held.map((frame) => frame.sessionId)).toEqual(['sess-a', 'sess-b'])

    // Answer in arrival order; each decision lands on its own held hook.
    await resolvePrompt(app, held[0]!.promptId!, 'allow')
    await resolvePrompt(app, held[1]!.promptId!, 'deny')

    expect(await (await firstHook).json()).toEqual({
      hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: { behavior: 'allow' } },
    })
    expect(await (await secondHook).json()).toEqual({
      hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: { behavior: 'deny' } },
    })
    await deck.close()
  })

  it('rejects a double resolution — the second tap hits an already-settled prompt', async () => {
    const { app } = buildApp()
    const deck = await openDeck(app)

    const hookResponse = postPermission(app)
    const promptId = /"promptId":"([^"]+)"/.exec(await deck.readUntil('event: permission'))![1]!

    expect((await resolvePrompt(app, promptId, 'allow')).status).toBe(200)
    expect((await resolvePrompt(app, promptId, 'deny')).status).toBe(404)
    // The first tap's decision stands.
    expect(await (await hookResponse).json()).toEqual({
      hookSpecificOutput: {
        hookEventName: 'PermissionRequest',
        decision: { behavior: 'allow' },
      },
    })
    await deck.close()
  })

  it('rejects the deck token on the hook route and the hook token on the resolution route — wrong scopes', async () => {
    const { app } = buildApp()

    const hookRoute = await app.request('/api/permission', {
      method: 'POST',
      headers: { Authorization: `Bearer ${DECK_TOKEN}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(permissionPayload()),
    })
    const resolutionRoute = await app.request('/api/prompts/some-id/resolution', {
      method: 'POST',
      headers: { Authorization: `Bearer ${HOOK_TOKEN}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'allow' }),
    })

    expect(hookRoute.status).toBe(403)
    expect(resolutionRoute.status).toBe(403)
  })

  it('rejects a resolution for an unknown prompt id with 404', async () => {
    const { app } = buildApp()

    const response = await resolvePrompt(app, 'no-such-prompt', 'allow')

    expect(response.status).toBe(404)
  })

  it.each([
    ['a non-PermissionRequest hook payload', permissionPayload({ hook_event_name: 'PreToolUse' })],
    ['a payload missing tool_name', permissionPayload({ tool_name: undefined })],
    ['a payload missing session_id', permissionPayload({ session_id: '' })],
  ])('rejects %s with 400', async (_label, payload) => {
    const { app } = buildApp()

    const response = await postPermission(app, payload)

    expect(response.status).toBe(400)
  })

  it('rejects a resolution with an unknown action with 400', async () => {
    const { app } = buildApp()

    const response = await resolvePrompt(app, 'any', 'approve')

    expect(response.status).toBe(400)
  })

  it('shows an unrecognized tool_input as its JSON — an approval card must never be blank', async () => {
    const { app } = buildApp({ permissionTimeoutMs: 30 })
    const deck = await openDeck(app)

    await postPermission(
      app,
      permissionPayload({ tool_name: 'WebFetch', tool_input: { url: 'https://sketchy.example' } }),
    )

    const frames = await deck.readUntil('event: permission')
    expect(frames).toContain('"tool":"WebFetch"')
    // The exact payload, JSON-encoded inside the SSE frame's JSON data.
    expect(frames).toContain(JSON.stringify(JSON.stringify({ url: 'https://sketchy.example' })))
    await deck.close()
  })

  it('carries a long command far beyond the ticker clamp — truncated approvals are blind approvals', async () => {
    const { app } = buildApp({ permissionTimeoutMs: 30 })
    const deck = await openDeck(app)
    // Realistic heredoc-sized command: well past the ticker's 200-char cap.
    const command = `bash -c '${'x'.repeat(1_500)}'`

    await postPermission(app, permissionPayload({ tool_input: { command } }))

    const frames = await deck.readUntil('event: permission')
    expect(frames).toContain(command)
    await deck.close()
  })

  it('bounds a pathological payload with a visible truncation marker — silently cut is silently lied', async () => {
    const { app } = buildApp({ permissionTimeoutMs: 30 })
    const deck = await openDeck(app)

    await postPermission(app, permissionPayload({ tool_input: { command: 'x'.repeat(100_000) } }))

    const frames = await deck.readUntil('event: permission')
    const detail = (JSON.parse(
      /^data: (.*)$/m.exec(frames.split('event: permission')[1]!)![1]!,
    ) as { detail: string }).detail
    expect(detail.length).toBeLessThan(5_000)
    expect(detail.endsWith('… [truncated]')).toBe(true)
    expect(detail.startsWith('xxxx')).toBe(true)
    await deck.close()
  })

  it('stamps D15 risk onto the card frame — only classifier-high commands demand the long hold', async () => {
    const { app } = buildApp({ permissionTimeoutMs: 30 })
    const deck = await openDeck(app)

    await postPermission(app) // rm -rf build — destructive delete
    await postPermission(app, permissionPayload({ tool_input: { command: 'ls -la' } }))
    // Ticker-highlighted is not approval-high: an install keeps the standard hold.
    await postPermission(app, permissionPayload({ tool_input: { command: 'npm install hono' } }))
    await postPermission(
      app,
      permissionPayload({ tool_name: 'Write', tool_input: { file_path: '/w/my-app/README.md' } }),
    )

    const frames = await deck.readUntil('README.md')
    const cards = frames
      .split('\n\n')
      .filter((block) => /^event: permission$/m.test(block))
      .map((block) => JSON.parse(/^data: (.*)$/m.exec(block)![1]!) as { tool: string; risk: string })
    expect(cards.map((card) => [card.tool, card.risk])).toEqual([
      ['Bash', 'high'],
      ['Bash', 'routine'],
      ['Bash', 'routine'],
      ['Write', 'routine'],
    ])
    await deck.close()
  })

  it('publishes permission-resolved after a tap — a replaying deck never renders a settled card', async () => {
    const { app } = buildApp()
    const deck = await openDeck(app)

    const hookResponse = postPermission(app)
    const promptId = /"promptId":"([^"]+)"/.exec(await deck.readUntil('event: permission'))![1]!
    await resolvePrompt(app, promptId, 'deny')
    await hookResponse

    const frames = await deck.readUntil('event: permission-resolved')
    expect(frames).toContain(`"promptId":"${promptId}"`)
    expect(frames).toContain('"outcome":"deny"')
    await deck.close()
  })

  it('always alerts on prompt arrival — a held prompt broadcasts a push carrying the payload', async () => {
    const sendPush = vi.fn<(sub: unknown, payload: string) => Promise<void>>(() => Promise.resolve())
    const { app } = buildApp({ alerts: { sendPush } })
    const deck = await openDeck(app)
    await app.request('/api/push/subscriptions', {
      method: 'POST',
      headers: { Authorization: `Bearer ${DECK_TOKEN}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        endpoint: 'https://push.example.com/sub/1',
        keys: { p256dh: 'p256dh-key', auth: 'auth-key' },
      }),
    })

    const hookResponse = postPermission(app)
    const promptId = /"promptId":"([^"]+)"/.exec(await deck.readUntil('event: permission'))![1]!

    expect(sendPush).toHaveBeenCalledTimes(1)
    expect(JSON.parse(sendPush.mock.calls[0]![1])).toEqual({
      kind: 'permission',
      title: 'my-app',
      tool: 'Bash',
      detail: 'rm -rf build',
    })

    await resolvePrompt(app, promptId, 'ask')
    await hookResponse
    await deck.close()
  })

  it('keeps the arrival push notification-sized — a full payload would bust the ~4KB Web Push cap', async () => {
    const sendPush = vi.fn<(sub: unknown, payload: string) => Promise<void>>(() => Promise.resolve())
    const { app } = buildApp({ alerts: { sendPush }, permissionTimeoutMs: 30 })
    const deck = await openDeck(app)
    await app.request('/api/push/subscriptions', {
      method: 'POST',
      headers: { Authorization: `Bearer ${DECK_TOKEN}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        endpoint: 'https://push.example.com/sub/1',
        keys: { p256dh: 'p256dh-key', auth: 'auth-key' },
      }),
    })

    await postPermission(app, permissionPayload({ tool_input: { command: 'x'.repeat(100_000) } }))

    expect(sendPush).toHaveBeenCalledTimes(1)
    // The full payload lives on the card; the push only needs to say "come look".
    expect(sendPush.mock.calls[0]![1].length).toBeLessThan(1_000)
    await deck.close()
  })

  it('never alerts for a prompt that fell back unheld — no deck means no card to answer', async () => {
    const sendPush = vi.fn<(sub: unknown, payload: string) => Promise<void>>(() => Promise.resolve())
    const { app } = buildApp({ alerts: { sendPush } })
    await app.request('/api/push/subscriptions', {
      method: 'POST',
      headers: { Authorization: `Bearer ${DECK_TOKEN}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        endpoint: 'https://push.example.com/sub/1',
        keys: { p256dh: 'p256dh-key', auth: 'auth-key' },
      }),
    })

    await postPermission(app)

    expect(sendPush).not.toHaveBeenCalled()
  })

  it('publishes permission-resolved with outcome ask when the silence fallback answers', async () => {
    const { app } = buildApp({ permissionTimeoutMs: 30 })
    const deck = await openDeck(app)

    await postPermission(app)

    const frames = await deck.readUntil('event: permission-resolved')
    expect(frames).toContain('"outcome":"ask"')
    await deck.close()
  })
})

describe('pause toggle (D5)', () => {
  it('flips to passthrough on a deck tap and streams the mode to the deck', async () => {
    const { app } = buildApp()
    const deck = await openDeck(app)

    const response = await togglePause(app)

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ paused: true })
    const frames = await deck.readUntil('event: mode')
    expect(frames).toContain('"paused":true')
    await deck.close()
  })

  it('makes a held-eligible prompt fall back instantly while paused — the terminal dialog proceeds', async () => {
    const { app } = buildApp()
    const deck = await openDeck(app)
    await togglePause(app)

    // A deck is connected, so without pause this would hold; paused, it must
    // answer immediately with the no-decision shape.
    const response = await postPermission(app)

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({})
    await deck.close()
  })

  it('resumes interception on a second tap — the prompt holds for the deck again', async () => {
    const { app } = buildApp()
    const deck = await openDeck(app)

    expect(await (await togglePause(app)).json()).toEqual({ paused: true })
    expect(await (await togglePause(app)).json()).toEqual({ paused: false })

    const hookResponse = postPermission(app)
    const promptId = /"promptId":"([^"]+)"/.exec(await deck.readUntil('event: permission'))![1]!
    await resolvePrompt(app, promptId, 'allow')

    expect(await (await hookResponse).json()).toEqual({
      hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: { behavior: 'allow' } },
    })
    await deck.close()
  })

  it('replays the mode change to a deck that reconnects after a blip — still paused', async () => {
    const { app } = buildApp()
    const first = await openDeck(app)
    await togglePause(app)
    await first.readUntil('event: mode')
    await first.close()

    // A real EventSource reconnect resends the last id it saw; the mode event
    // sits after it in the ring buffer and replays. Id 0 is "everything since
    // the start" — the whole buffer, which here is just the mode event.
    const second = await app.request(`/api/stream?token=${DECK_TOKEN}`, {
      headers: { 'Last-Event-ID': '0' },
    })
    const reader = second.body!.getReader()
    const decoder = new TextDecoder()
    let buffered = ''
    while (!buffered.includes('event: mode')) {
      buffered += decoder.decode((await reader.read()).value)
    }
    expect(buffered).toContain('"paused":true')
    await reader.cancel()
  })

  it('reports the current mode from deck-config so a hard reload starts with the right accent', async () => {
    const { app } = buildApp()

    const before = await app.request('/api/deck-config', {
      headers: { Authorization: `Bearer ${DECK_TOKEN}` },
    })
    expect(((await before.json()) as { paused: boolean }).paused).toBe(false)

    await togglePause(app)

    const after = await app.request('/api/deck-config', {
      headers: { Authorization: `Bearer ${DECK_TOKEN}` },
    })
    expect(((await after.json()) as { paused: boolean }).paused).toBe(true)
  })

  it('rejects the hook token on the pause route — pausing is a deck control', async () => {
    const { app } = buildApp()

    const response = await togglePause(app, HOOK_TOKEN)

    expect(response.status).toBe(403)
  })
})
