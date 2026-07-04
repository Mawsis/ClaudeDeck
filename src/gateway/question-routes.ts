import { basename } from 'node:path'
import type { Hono } from 'hono'
import { requireScope, type AuthTokens } from './auth.ts'
import type { EventLog } from './event-log.ts'
import type { QuestionSpec } from './events.ts'
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

/**
 * AskUserQuestion's input shape is undocumented territory (D3): today it is
 * `{ questions: [{ question, header?, options: [{ label }], multiSelect? }] }`.
 * Extraction is lenient — an unrecognized shape returns undefined and the
 * caller falls back to the terminal, never a 400 that Claude would log as a
 * hook error.
 */
function extractQuestions(toolInput: unknown): readonly QuestionSpec[] | undefined {
  if (typeof toolInput !== 'object' || toolInput === null) return undefined
  const questions = (toolInput as Record<string, unknown>).questions
  if (!Array.isArray(questions) || questions.length === 0) return undefined
  const specs: QuestionSpec[] = []
  for (const entry of questions) {
    if (typeof entry !== 'object' || entry === null) return undefined
    const record = entry as Record<string, unknown>
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
    specs.push({
      question: record.question,
      header: typeof record.header === 'string' ? record.header : '',
      options,
      multiSelect: record.multiSelect === true,
    })
  }
  return specs
}

/**
 * A complete answer set: one entry per question, single-select carries
 * exactly one choice, multiSelect one or more, every choice a real option
 * label. Anything less would compose a deny reason that lies about what the
 * user was asked.
 */
function answersMatchQuestions(
  questions: readonly QuestionSpec[],
  answers: readonly (readonly string[])[],
): boolean {
  if (answers.length !== questions.length) return false
  return questions.every((spec, index) => {
    const choices = answers[index]!
    if (!spec.multiSelect && choices.length !== 1) return false
    return choices.every((choice) => spec.options.includes(choice))
  })
}

/**
 * The whole call is answered by ONE deny reason (D3) — sequencing happens on
 * the deck; this string is where the answers recombine. The single-question
 * form is the canary-validated one and must not drift.
 */
function composeReason(
  questions: readonly QuestionSpec[],
  answers: readonly (readonly string[])[],
): string {
  if (questions.length === 1) return `User selected: ${answers[0]!.join(', ')}`
  const parts = questions.map((spec, index) => {
    const label = spec.header !== '' ? spec.header : spec.question
    return `${label}: ${answers[index]!.join(', ')}`
  })
  return `User answered — ${parts.join('; ')}`
}

/**
 * Questions time out far sooner than permission prompts (540s): a stale
 * answer to a question mid-plan derails the session, while an unanswered
 * question just re-renders in the terminal.
 */
export const DEFAULT_QUESTION_TIMEOUT_MS = 60_000

export type QuestionRoutesConfig = {
  readonly tokens: AuthTokens
  readonly eventLog: EventLog
  readonly hasDeck: () => boolean
  /** D5: while paused, a question falls back to the terminal instead of holding. */
  readonly isPaused?: (() => boolean) | undefined
  readonly timeoutMs?: number | undefined
}

/** The deck's answer to an AskUserQuestion: one choice-label set per
 * question, in question order. `null` means "no answer" — every fallback,
 * so the terminal re-asks. */
type QuestionAnswer = { readonly answers: readonly (readonly string[])[] }

/** Lenient body parse only — set-level validation needs the question specs. */
function parseAnswersBody(body: unknown): QuestionAnswer | 'ask' | undefined {
  if (typeof body !== 'object' || body === null) return undefined
  const record = body as Record<string, unknown>
  // Ask-in-terminal is a real answer whose content is "no answer" — the
  // held hook returns "ask" and the terminal renders the question (D3/D4).
  if (record.ask === true) return 'ask'
  if (!Array.isArray(record.answers)) return undefined
  const answers = record.answers.map((entry) =>
    Array.isArray(entry)
      ? entry.filter((choice): choice is string => typeof choice === 'string' && choice !== '')
      : undefined,
  )
  if (answers.some((entry) => entry === undefined || entry.length === 0)) return undefined
  return { answers: answers as string[][] }
}

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
    timeoutMs: config.timeoutMs ?? DEFAULT_QUESTION_TIMEOUT_MS,
  })
  // What each held prompt actually asked — the answer route validates against
  // it. Entries live exactly as long as the hold; every settle path (answer,
  // ask, timeout) flows through the awaited decision below and cleans up.
  const heldQuestions = new Map<string, readonly QuestionSpec[]>()

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

    const questions = extractQuestions(payload.tool_input)
    if (questions === undefined) return c.json(ASK_RESPONSE, 200)

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
      heldQuestions.set(held.id, questions)
      eventLog.publish({ type: 'question', ...base, questions })
    }

    const answer = await held.decision
    heldQuestions.delete(held.id)
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
          permissionDecisionReason: composeReason(questions, answer.answers),
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

    const answer = parseAnswersBody(body)
    if (answer === undefined) {
      return c.json({ error: 'expected { answers: string[][] } or { ask: true }' }, 400)
    }

    // A mismatched set 400s WITHOUT settling — the card stays live so the
    // deck can correct itself; only a complete, honest set may compose.
    if (answer !== 'ask') {
      const questions = heldQuestions.get(c.req.param('id'))
      if (questions !== undefined && !answersMatchQuestions(questions, answer.answers)) {
        return c.json({ error: 'answers do not match the held questions' }, 400)
      }
    }

    if (!questionStore.resolve(c.req.param('id'), answer === 'ask' ? null : answer)) {
      return c.json({ error: 'unknown or already resolved question' }, 404)
    }
    return c.json({ ok: true }, 200)
  })
}
