import { afterEach, describe, expect, it, vi } from 'vitest'
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
    // The event carries the full question set — text, header, options, and
    // the multiSelect flag per question — so the deck can render any shape.
    expect(frames).toContain(
      '"questions":[{"question":"Which auth method should we use?","header":"Auth method","options":["OAuth","API key"],"multiSelect":false}]',
    )
    expect(frames).toContain('"title":"my-app"')
    const promptId = /"promptId":"([^"]+)"/.exec(frames)![1]!

    const answerResponse = await answerQuestion(app, promptId, { answers: [['API key']] })
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
    const { app } = buildApp({ questionTimeoutMs: 30 })
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

  it('holds a multi-question payload, streams the full set, and composes all answers into one deny reason', async () => {
    const { app } = buildApp()
    const deck = await openDeck(app)

    const hookResponsePromise = postQuestion(
      app,
      questionPayload({
        tool_input: {
          questions: [
            {
              question: 'Which auth method?',
              header: 'Auth method',
              options: [{ label: 'OAuth' }, { label: 'API key' }],
            },
            {
              question: 'Which database?',
              header: 'Database',
              options: [{ label: 'Postgres' }, { label: 'SQLite' }],
            },
          ],
        },
      }),
    )

    const frames = await deck.readUntil('event: question')
    expect(frames).toContain('"question":"Which auth method?"')
    expect(frames).toContain('"question":"Which database?"')
    const promptId = /"promptId":"([^"]+)"/.exec(frames)![1]!

    const answerResponse = await answerQuestion(app, promptId, {
      answers: [['OAuth'], ['Postgres']],
    })
    expect(answerResponse.status).toBe(200)

    // One held hook, one reason string: the deck's sequenced answers
    // recombine here, labeled by header so Claude can match them back.
    expect(await (await hookResponsePromise).json()).toEqual({
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'deny',
        permissionDecisionReason: 'User answered — Auth method: OAuth; Database: Postgres',
      },
    })
    deck.close()
  })

  it('holds a multiSelect question, flags it on the card, and joins the toggled choices in the deny reason', async () => {
    const { app } = buildApp()
    const deck = await openDeck(app)

    const hookResponsePromise = postQuestion(
      app,
      questionPayload({
        tool_input: {
          questions: [
            {
              question: 'Which features do you want?',
              header: 'Features',
              multiSelect: true,
              options: [{ label: 'Auth' }, { label: 'Billing' }, { label: 'Search' }],
            },
          ],
        },
      }),
    )

    const frames = await deck.readUntil('event: question')
    expect(frames).toContain('"multiSelect":true')
    const promptId = /"promptId":"([^"]+)"/.exec(frames)![1]!

    const answerResponse = await answerQuestion(app, promptId, {
      answers: [['Auth', 'Search']],
    })
    expect(answerResponse.status).toBe(200)

    expect(await (await hookResponsePromise).json()).toEqual({
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'deny',
        permissionDecisionReason: 'User selected: Auth, Search',
      },
    })
    deck.close()
  })

  describe('with fake timers', () => {
    afterEach(() => {
      vi.useRealTimers()
    })

    it('times out an unanswered question at the 60s default while a permission prompt keeps its 540s window', async () => {
      // Only setTimeout — SSE streaming must keep running on real scheduling.
      vi.useFakeTimers({ toFake: ['setTimeout'] })
      const { app } = buildApp()
      const deck = await openDeck(app)

      const questionResponsePromise = postQuestion(app)
      const permissionResponsePromise = Promise.resolve(
        app.request('/api/permission', {
          method: 'POST',
          headers: { Authorization: `Bearer ${HOOK_TOKEN}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({
            hook_event_name: 'PermissionRequest',
            session_id: 'sess-q',
            cwd: '/w/my-app',
            tool_name: 'Bash',
            tool_input: { command: 'rm -rf build' },
          }),
        }),
      )
      await deck.readUntil('event: question')

      await vi.advanceTimersByTimeAsync(60_000)

      // The question hook is back in the terminal's hands…
      expect(await (await questionResponsePromise).json()).toEqual({
        hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'ask' },
      })
      const frames = await deck.readUntil('event: question-resolved')
      expect(frames).toContain('"outcome":"ask"')

      // …while the permission prompt is still held until its own 540s window.
      await vi.advanceTimersByTimeAsync(540_000 - 60_000 - 1)
      let permissionSettled = false
      void permissionResponsePromise.then(() => {
        permissionSettled = true
      })
      await Promise.resolve()
      expect(permissionSettled).toBe(false)

      await vi.advanceTimersByTimeAsync(1)
      // {} is the permission gate's documented no-decision fallback.
      expect(await (await permissionResponsePromise).json()).toEqual({})
      deck.close()
    })
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

    expect((await answerQuestion(app, 'no-such-id', { answers: [['OAuth']] })).status).toBe(404)
    expect((await answerQuestion(app, promptId, { answers: [['OAuth']] })).status).toBe(200)
    // A double tap must not answer a question that already settled.
    expect((await answerQuestion(app, promptId, { answers: [['API key']] })).status).toBe(404)

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

  it('rejects an answer set that does not match the questions — the hook stays held and answerable', async () => {
    const { app } = buildApp()
    const deck = await openDeck(app)

    const hookResponsePromise = postQuestion(
      app,
      questionPayload({
        tool_input: {
          questions: [
            {
              question: 'Which auth method?',
              header: 'Auth method',
              options: [{ label: 'OAuth' }, { label: 'API key' }],
            },
            {
              question: 'Which features?',
              header: 'Features',
              multiSelect: true,
              options: [{ label: 'Auth' }, { label: 'Billing' }],
            },
          ],
        },
      }),
    )
    const promptId = /"promptId":"([^"]+)"/.exec(await deck.readUntil('event: question'))![1]!

    // A partial or malformed set must not settle the hook: wrong count, two
    // choices on a single-select, a label that was never an option.
    for (const bad of [
      { answers: [['OAuth']] },
      { answers: [['OAuth', 'API key'], ['Auth']] },
      { answers: [['OAuth'], ['Espresso']] },
    ]) {
      expect((await answerQuestion(app, promptId, bad)).status).toBe(400)
    }

    // The card is still live — a corrected answer settles it normally.
    expect(
      (await answerQuestion(app, promptId, { answers: [['OAuth'], ['Auth', 'Billing']] })).status,
    ).toBe(200)
    expect(await (await hookResponsePromise).json()).toEqual({
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'deny',
        permissionDecisionReason: 'User answered — Auth method: OAuth; Features: Auth, Billing',
      },
    })
    deck.close()
  })

  it('rejects an answer body that is neither { answers } nor { ask: true }', async () => {
    const { app } = buildApp()

    // The retired single-choice format included — one wire format, no aliases.
    for (const bad of [{ choice: 'OAuth' }, { answers: 'OAuth' }, {}]) {
      expect((await answerQuestion(app, 'any-id', bad)).status).toBe(400)
    }
  })
})
