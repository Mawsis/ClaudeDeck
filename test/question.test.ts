import { describe, expect, it } from 'vitest'
import { buildApp, DECK_TOKEN, HOOK_TOKEN } from './helpers.ts'

/** Opens a deck SSE stream and reads frames until a marker appears. */
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

const questionPayload = (overrides: Record<string, unknown> = {}) => ({
  hook_event_name: 'PreToolUse',
  session_id: 'sess-q',
  cwd: '/w/my-app',
  tool_name: 'AskUserQuestion',
  tool_input: {
    questions: [
      {
        question: 'Which auth method should we use?',
        header: 'Auth method',
        options: [
          { label: 'OAuth', description: 'Redirect flow' },
          { label: 'API key', description: 'Static secret' },
        ],
      },
    ],
  },
  ...overrides,
})

const postQuestion = (
  app: ReturnType<typeof buildApp>['app'],
  payload: unknown = questionPayload(),
) =>
  app.request('/api/question', {
    method: 'POST',
    headers: { Authorization: `Bearer ${HOOK_TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  })

const answerQuestion = (
  app: ReturnType<typeof buildApp>['app'],
  promptId: string,
  body: unknown,
) =>
  app.request(`/api/questions/${promptId}/answer`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${DECK_TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })

describe('question hold contract', () => {
  it('answers immediately with permissionDecision "ask" when no deck is connected', async () => {
    const { app } = buildApp()

    const response = await postQuestion(app)

    // D4 for the AskUserQuestion hack: every fallback is "ask" — the question
    // renders in the terminal, never a silent deny.
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({
      hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'ask' },
    })
  })

  it('streams the question with tappable options to a connected deck, then answers the held hook with deny-carrying the tapped choice', async () => {
    const { app } = buildApp()
    const deck = await openDeck(app)

    const hookResponsePromise = postQuestion(app)

    const frames = await deck.readUntil('event: question')
    expect(frames).toContain('"question":"Which auth method should we use?"')
    expect(frames).toContain('"options":["OAuth","API key"]')
    expect(frames).toContain('"title":"my-app"')
    const promptId = /"promptId":"([^"]+)"/.exec(frames)![1]!

    const answerResponse = await answerQuestion(app, promptId, { choice: 'API key' })
    expect(answerResponse.status).toBe(200)

    // The deny reason is the transport for the selection (D3) — Claude reads
    // it as the answer.
    const hookResponse = await hookResponsePromise
    expect(hookResponse.status).toBe(200)
    expect(await hookResponse.json()).toEqual({
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'deny',
        permissionDecisionReason: 'User selected: API key',
      },
    })

    // The card must leave every connected deck's queue once settled.
    const resolvedFrames = await deck.readUntil('event: question-resolved')
    expect(resolvedFrames).toContain(`"promptId":"${promptId}"`)
    deck.close()
  })

  it('falls back to "ask" instantly while paused, even with a deck connected', async () => {
    const { app } = buildApp()
    const deck = await openDeck(app)
    const pauseResponse = await app.request('/api/pause', {
      method: 'POST',
      headers: { Authorization: `Bearer ${DECK_TOKEN}`, 'Content-Type': 'application/json' },
      body: '{}',
    })
    expect(pauseResponse.status).toBe(200)

    const response = await postQuestion(app)

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({
      hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'ask' },
    })
    deck.close()
  })

  it('falls back to "ask" when a connected deck stays silent past the timeout, and clears the card', async () => {
    const { app } = buildApp({ permissionTimeoutMs: 30 })
    const deck = await openDeck(app)

    const response = await postQuestion(app)

    expect(await response.json()).toEqual({
      hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'ask' },
    })
    // The deck must drop the card — the terminal owns the question now.
    const frames = await deck.readUntil('event: question-resolved')
    expect(frames).toContain('"outcome":"ask"')
    deck.close()
  })

  it('falls back to "ask" on an unrecognized tool_input shape instead of erroring', async () => {
    const { app } = buildApp()
    const deck = await openDeck(app)

    // Undocumented behavior may reshape under us (D3): a payload the gateway
    // can't render must degrade to the terminal, never a hook error.
    const response = await postQuestion(app, questionPayload({ tool_input: { surprise: true } }))

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({
      hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'ask' },
    })
    deck.close()
  })

  it('rejects a payload that is not a PreToolUse AskUserQuestion hook', async () => {
    const { app } = buildApp()

    const response = await postQuestion(app, { hook_event_name: 'PostToolUse' })

    expect(response.status).toBe(400)
  })

  it('404s an answer for an unknown prompt id and a second answer for a settled one', async () => {
    const { app } = buildApp()
    const deck = await openDeck(app)

    const hookResponsePromise = postQuestion(app)
    const frames = await deck.readUntil('event: question')
    const promptId = /"promptId":"([^"]+)"/.exec(frames)![1]!

    expect((await answerQuestion(app, 'no-such-id', { choice: 'OAuth' })).status).toBe(404)
    expect((await answerQuestion(app, promptId, { choice: 'OAuth' })).status).toBe(200)
    // A double tap must not answer a question that already settled.
    expect((await answerQuestion(app, promptId, { choice: 'API key' })).status).toBe(404)

    const hookResponse = await hookResponsePromise
    const hookBody = (await hookResponse.json()) as {
      hookSpecificOutput: { permissionDecisionReason: string }
    }
    expect(hookBody.hookSpecificOutput.permissionDecisionReason).toBe('User selected: OAuth')
    deck.close()
  })

  it('lets the deck send the question to the terminal explicitly — ask is a real answer', async () => {
    const { app } = buildApp()
    const deck = await openDeck(app)

    const hookResponsePromise = postQuestion(app)
    const frames = await deck.readUntil('event: question')
    const promptId = /"promptId":"([^"]+)"/.exec(frames)![1]!

    const answerResponse = await answerQuestion(app, promptId, { ask: true })
    expect(answerResponse.status).toBe(200)

    expect(await (await hookResponsePromise).json()).toEqual({
      hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'ask' },
    })
    const resolvedFrames = await deck.readUntil('event: question-resolved')
    expect(resolvedFrames).toContain('"outcome":"ask"')
    deck.close()
  })

  it('rejects an answer without a choice string', async () => {
    const { app } = buildApp()

    const response = await answerQuestion(app, 'any-id', { choice: '' })

    expect(response.status).toBe(400)
  })
})
