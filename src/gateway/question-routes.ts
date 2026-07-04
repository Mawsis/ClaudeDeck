import { basename } from 'node:path'
import type { Hono } from 'hono'
import { requireScope, type AuthTokens } from './auth.ts'
import type { EventLog } from './event-log.ts'
import { createPendingPromptStore } from './pending-prompts.ts'

const MAX_TITLE_LENGTH = 120

type QuestionPayload = {
  readonly session_id: string
  readonly cwd: string
  readonly tool_input: unknown
}

function parseQuestionPayload(body: unknown): QuestionPayload | undefined {
  if (typeof body !== 'object' || body === null) return undefined
  const record = body as Record<string, unknown>
  if (record.hook_event_name !== 'PreToolUse') return undefined
  if (record.tool_name !== 'AskUserQuestion') return undefined
  if (typeof record.session_id !== 'string' || record.session_id === '') return undefined
  if (typeof record.cwd !== 'string' || record.cwd === '') return undefined
  return { session_id: record.session_id, cwd: record.cwd, tool_input: record.tool_input }
}

type ExtractedQuestion = { readonly question: string; readonly options: readonly string[] }

/**
 * AskUserQuestion's input shape is undocumented territory (D3): today it is
 * `{ questions: [{ question, options: [{ label }] }] }`. Extraction is
 * lenient — an unrecognized shape returns undefined and the caller falls
 * back to the terminal, never a 400 that Claude would log as a hook error.
 * Only the first question renders; a multi-question call can't be answered
 * by a single deny reason anyway.
 */
function extractQuestion(toolInput: unknown): ExtractedQuestion | undefined {
  if (typeof toolInput !== 'object' || toolInput === null) return undefined
  const questions = (toolInput as Record<string, unknown>).questions
  if (!Array.isArray(questions)) return undefined
  const first = questions[0]
  if (typeof first !== 'object' || first === null) return undefined
  const record = first as Record<string, unknown>
  if (typeof record.question !== 'string' || record.question === '') return undefined
  if (!Array.isArray(record.options)) return undefined
  const options = record.options
    .map((option) =>
      typeof option === 'object' && option !== null
        ? (option as Record<string, unknown>).label
        : undefined,
    )
    .filter((label): label is string => typeof label === 'string' && label !== '')
  if (options.length === 0) return undefined
  return { question: record.question, options }
}

export type QuestionRoutesConfig = {
  readonly tokens: AuthTokens
  readonly eventLog: EventLog
  readonly hasDeck: () => boolean
  /** D5: while paused, a question falls back to the terminal instead of holding. */
  readonly isPaused?: (() => boolean) | undefined
  /** Test seam only — production uses the 540s D4 default. */
  readonly timeoutMs?: number | undefined
}

/** The deck's answer to an AskUserQuestion: the tapped choice label.
 * `null` means "no answer" — every fallback, so the terminal re-asks. */
type QuestionAnswer = { readonly choice: string }

const ASK_RESPONSE = {
  hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'ask' },
} as const

/**
 * The AskUserQuestion hack (D3/D4): a PreToolUse http hook matched to
 * AskUserQuestion alone is held open while the deck picks a choice, then
 * answered with `permissionDecision: "deny"` whose reason carries the
 * selection — undocumented behavior Claude reads as the answer. Every
 * fallback (no deck, pause, timeout, unrecognized payload shape) is
 * `permissionDecision: "ask"`, which lets the question render in the
 * terminal normally.
 */
export function registerQuestionRoutes(app: Hono, config: QuestionRoutesConfig): void {
  const { tokens, eventLog } = config

  const questionStore = createPendingPromptStore<QuestionAnswer>({
    hasDeck: config.hasDeck,
    ...(config.isPaused !== undefined ? { isPaused: config.isPaused } : {}),
    ...(config.timeoutMs !== undefined ? { timeoutMs: config.timeoutMs } : {}),
  })

  app.post('/api/question', requireScope('hook', tokens), async (c) => {
    let body: unknown
    try {
      body = await c.req.json()
    } catch {
      return c.json({ error: 'body must be JSON' }, 400)
    }

    const payload = parseQuestionPayload(body)
    if (payload === undefined) {
      return c.json(
        { error: 'expected a PreToolUse AskUserQuestion payload with session_id and cwd' },
        400,
      )
    }

    const extracted = extractQuestion(payload.tool_input)
    if (extracted === undefined) return c.json(ASK_RESPONSE, 200)

    const held = questionStore.hold()
    const base = {
      sessionId: payload.session_id,
      title: basename(payload.cwd).slice(0, MAX_TITLE_LENGTH),
      cwd: payload.cwd,
      promptId: held.id,
    }
    // A question the fallback already answered was never pending — a card
    // that renders after its hook returned would offer a dead tap.
    if (held.pending) {
      eventLog.publish({ type: 'question', ...base, ...extracted })
    }

    const answer = await held.decision
    if (held.pending) {
      eventLog.publish({
        type: 'question-resolved',
        ...base,
        outcome: answer === null ? 'ask' : 'answered',
      })
    }
    if (answer === null) return c.json(ASK_RESPONSE, 200)
    return c.json(
      {
        hookSpecificOutput: {
          hookEventName: 'PreToolUse',
          permissionDecision: 'deny',
          permissionDecisionReason: `User selected: ${answer.choice}`,
        },
      },
      200,
    )
  })

  app.post('/api/questions/:id/answer', requireScope('deck', tokens), async (c) => {
    let body: unknown
    try {
      body = await c.req.json()
    } catch {
      return c.json({ error: 'body must be JSON' }, 400)
    }

    const record = typeof body === 'object' && body !== null ? (body as Record<string, unknown>) : {}
    // Ask-in-terminal is a real answer whose content is "no answer" — the
    // held hook returns "ask" and the terminal renders the question (D3/D4).
    const answer = record.ask === true ? null : record.choice
    if (answer !== null && (typeof answer !== 'string' || answer === '')) {
      return c.json({ error: 'expected { choice: string } or { ask: true }' }, 400)
    }

    if (!questionStore.resolve(c.req.param('id'), answer === null ? null : { choice: answer })) {
      return c.json({ error: 'unknown or already resolved question' }, 404)
    }
    return c.json({ ok: true }, 200)
  })
}
