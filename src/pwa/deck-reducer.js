// Pure deck state machine, shared verbatim between the browser (served as a
// static module, no build step) and vitest — which is why this file is plain
// JS with JSDoc types instead of TypeScript.

/**
 * @typedef {{ type: 'prompt' | 'stop', sessionId: string, title: string, at: number }
 *   | { type: 'mode', paused: boolean, at: number }} DeckEvent
 * @typedef {{ status: 'running', title: string, since: number }} RunningSession
 * @typedef {{ status: 'done', title: string, elapsedMs: number | null }} DoneSession
 * @typedef {RunningSession | DoneSession} SessionState
 * @typedef {{ activeSessionId: string | null, sessions: Readonly<Record<string, SessionState>>,
 *   paused: boolean, seenSession: boolean }} DeckState
 * @typedef {{ mode: 'idle' }
 *   | { mode: 'running', title: string, elapsedMs: number }
 *   | { mode: 'done', title: string, elapsedMs: number | null }
 *   | { mode: 'offline' }} DeckViewBase
 * @typedef {DeckViewBase & { paused?: true }} DeckView
 */

/** @type {DeckState} */
export const initialDeckState = Object.freeze({
  activeSessionId: null,
  sessions: Object.freeze({}),
  paused: false,
  seenSession: false,
})

/**
 * @param {DeckState} state
 * @param {DeckEvent} event
 * @returns {DeckState}
 */
export function reduceDeck(state, event) {
  // D5: interception mode is orthogonal to the session clock — a pause overlays
  // whichever session is active without touching the timer or the active id.
  if (event.type === 'mode') {
    return { ...state, paused: event.paused }
  }

  const previous = state.sessions[event.sessionId]

  /** @type {SessionState} */
  const session =
    event.type === 'prompt'
      ? {
          status: 'running',
          title: event.title,
          // A prompt queued mid-turn must not reset the visible timer.
          since: previous?.status === 'running' ? previous.since : event.at,
        }
      : {
          status: 'done',
          title: event.title,
          // A redelivered stop must not erase the frozen duration; only a
          // stop with no observed prompt has a genuinely unknown duration.
          elapsedMs:
            previous?.status === 'running'
              ? event.at - previous.since
              : previous?.status === 'done'
                ? previous.elapsedMs
                : null,
        }

  return {
    ...state,
    activeSessionId: event.sessionId,
    sessions: { ...state.sessions, [event.sessionId]: session },
    // Any prompt or stop proves the pipeline has carried a real session —
    // the one-way latch behind the first-run hint.
    seenSession: true,
  }
}

/**
 * The one-time first-run hint: shown only while the event log has never
 * contained a session event. Mode events don't count — pausing an empty deck
 * proves nothing about the hook pipeline.
 *
 * @param {DeckState} state
 * @returns {boolean}
 */
export function firstRunHint(state) {
  return !state.seenSession
}

/**
 * @param {DeckState} state
 * @param {number} now
 * @param {{ connected?: boolean }} [connection] A down stream always projects
 *   offline — a stale clock is a lie the deck must never tell.
 * @returns {DeckView}
 */
export function deckView(state, now, { connected = true } = {}) {
  // Offline wins over every other accent: a stale clock is a worse lie than a
  // stale paused badge, so a down stream must not paint a reassuring mode.
  if (!connected) return { mode: 'offline' }
  // D5/D14: the purple paused accent overlays whatever session view is active,
  // added only when set so the intercepting default stays a bare view.
  const paused = state.paused ? /** @type {const} */ ({ paused: true }) : undefined
  const active = state.activeSessionId === null ? undefined : state.sessions[state.activeSessionId]
  if (active === undefined) return { mode: 'idle', ...paused }
  if (active.status === 'running') {
    return { mode: 'running', title: active.title, elapsedMs: now - active.since, ...paused }
  }
  return { mode: 'done', title: active.title, elapsedMs: active.elapsedMs, ...paused }
}

/**
 * How many sessions have a prompt submitted and no stop yet. Idle-but-alive
 * sessions never emitted an event, so they are absent from the map entirely.
 *
 * @param {DeckState} state
 * @returns {number}
 */
export function runningSessionCount(state) {
  return Object.values(state.sessions).filter((session) => session.status === 'running').length
}

/**
 * The clock's ambient honesty: a dim `×N` next to the session label whenever
 * other work runs behind the shown session. Empty at zero so the chrome
 * collapses to nothing — no ghost badge on a quiet deck.
 *
 * @param {DeckState} state
 * @returns {string}
 */
export function runningCountBadge(state) {
  const count = runningSessionCount(state)
  return count > 0 ? `×${count}` : ''
}

/** D11: short conversational turns stay silent — only real work alerts. */
export const DEFAULT_ALERT_THRESHOLD_MS = 45_000

// A stop older than this at receipt is history, not news: a reloading deck
// replays the whole ring buffer, and re-pinging an already-delivered alert
// would be a lie. Wide enough to cover a few EventSource retry cycles.
export const MAX_ALERT_AGE_MS = 10_000

/**
 * @typedef {{ channel: 'in-page' | 'push', title: string, elapsedMs: number }} AlertDecision
 */

/**
 * Decide whether a deck event warrants a completion alert, and on which
 * channel. Evaluated against the state *before* the event is reduced.
 *
 * @param {DeckState} state
 * @param {DeckEvent} event
 * @param {{ thresholdMs?: number, visible?: boolean, now?: number }} [options]
 *   `now` is the receipt-time reading of the same clock as `event.at` —
 *   omitted only where events are consumed live (age always zero).
 * @returns {AlertDecision | null}
 */
export function completionAlert(state, event, options = {}) {
  const { thresholdMs = DEFAULT_ALERT_THRESHOLD_MS, visible = false, now } = options
  if (event.type !== 'stop') return null
  if (now !== undefined && now - event.at > MAX_ALERT_AGE_MS) return null
  const previous = state.sessions[event.sessionId]
  if (previous?.status !== 'running') return null
  const elapsedMs = event.at - previous.since
  if (elapsedMs < thresholdMs) return null
  return {
    channel: visible ? /** @type {const} */ ('in-page') : /** @type {const} */ ('push'),
    title: event.title,
    elapsedMs,
  }
}

/**
 * Rebase a frame's event time onto this device's clock. The gateway stamps
 * every frame with `serverNow`, so `serverNow - at` is the event's age — a
 * difference of two readings of the *same* clock, immune to skew between the
 * server and the deck. Live frames have age 0; replayed frames keep their
 * true age, so timers stay honest across a network blip.
 *
 * @param {{ at: number, serverNow?: number }} frame
 * @param {number} receiptNow this device's clock at receipt
 * @returns {number} the event time expressed in this device's clock
 */
export function localEventTime(frame, receiptNow) {
  const age = typeof frame.serverNow === 'number' ? Math.max(0, frame.serverNow - frame.at) : 0
  return receiptNow - age
}

/**
 * @typedef {{ kind: 'permission', promptId: string, sessionId: string, title: string,
 *   tool: string, detail: string, risk: 'high' | 'routine' }} PermissionCard
 * @typedef {{ question: string, header: string, options: readonly string[],
 *   multiSelect: boolean }} QuestionSpec
 * @typedef {{ kind: 'question', promptId: string, sessionId: string, title: string,
 *   questions: readonly QuestionSpec[] }} QuestionCard
 * @typedef {PermissionCard | QuestionCard} PendingPrompt
 */

/**
 * External JSON never renders as objects — every field is coerced.
 *
 * @param {unknown} entry
 * @returns {QuestionSpec}
 */
function normalizeQuestionSpec(entry) {
  const record = typeof entry === 'object' && entry !== null ? /** @type {Record<string, unknown>} */ (entry) : {}
  return {
    question: String(record.question ?? ''),
    header: typeof record.header === 'string' ? record.header : '',
    options: (Array.isArray(record.options) ? record.options : []).map((option) =>
      String(option ?? ''),
    ),
    multiSelect: record.multiSelect === true,
  }
}

/** @type {readonly PendingPrompt[]} */
export const initialPrompts = Object.freeze([])

/**
 * Pending takeover cards — permission approvals and AskUserQuestion choices —
 * oldest first in one FIFO queue; the deck renders prompts[0].
 *
 * @param {readonly PendingPrompt[]} prompts
 * @param {{ type: string, id?: number, at?: number, promptId?: string, sessionId?: string,
 *   title?: string, tool?: string, detail?: string, risk?: string, outcome?: string,
 *   questions?: readonly unknown[] }} event a deck SSE frame — external
 *   JSON, so fields are normalized, not trusted.
 * @returns {readonly PendingPrompt[]}
 */
export function reducePrompts(prompts, event) {
  if (event.type === 'permission-resolved' || event.type === 'question-resolved') {
    return prompts.filter((prompt) => prompt.promptId !== event.promptId)
  }
  if (event.type !== 'permission' && event.type !== 'question') return prompts
  // Reconnect replay is at-least-once; a redelivered prompt is the same card.
  // promptIds are unique per gateway process, and the ring buffer (like every
  // pending prompt) dies with it — cross-restart collisions can't replay.
  if (prompts.some((prompt) => prompt.promptId === event.promptId)) return prompts
  const base = {
    promptId: String(event.promptId ?? ''),
    sessionId: String(event.sessionId ?? ''),
    title: String(event.title ?? ''),
  }
  if (event.type === 'question') {
    return [
      ...prompts,
      {
        kind: /** @type {const} */ ('question'),
        ...base,
        questions: (Array.isArray(event.questions) ? event.questions : []).map(
          normalizeQuestionSpec,
        ),
      },
    ]
  }
  return [
    ...prompts,
    {
      kind: /** @type {const} */ ('permission'),
      ...base,
      tool: String(event.tool ?? ''),
      detail: String(event.detail ?? ''),
      // Only the exact D15 marker stretches the hold; anything else — absent,
      // junk, or a future tier — gets the standard one, which still gates.
      risk: event.risk === 'high' ? /** @type {const} */ ('high') : /** @type {const} */ ('routine'),
    },
  ]
}

/**
 * @typedef {{ step: number, answers: readonly (readonly string[])[],
 *   selected: readonly string[] }} QuestionDraft
 * @typedef {{ type: 'tap', choice: string } | { type: 'confirm' }} QuestionDraftAction
 */

/** A fresh card: first question, nothing chosen.
 * @type {QuestionDraft} */
export const initialQuestionDraft = Object.freeze({
  step: 0,
  answers: Object.freeze([]),
  selected: Object.freeze([]),
})

/**
 * The multi-step answering flow as pure state (one AskUserQuestion call is
 * answered whole — the gateway rejects partial sets, so the draft only
 * becomes postable once every question has an answer). A tap answers a
 * single-select question and advances; on a multiSelect question it toggles
 * the choice, and only confirm commits the set and advances.
 *
 * @param {readonly QuestionSpec[]} questions
 * @param {QuestionDraft} draft
 * @param {QuestionDraftAction} action
 * @returns {QuestionDraft}
 */
export function reduceQuestionDraft(questions, draft, action) {
  const current = questions[draft.step]
  // Every question already answered (or junk step): nothing left to change.
  if (current === undefined) return draft
  if (action.type === 'tap') {
    if (!current.multiSelect) {
      return { step: draft.step + 1, answers: [...draft.answers, [action.choice]], selected: [] }
    }
    const toggledOff = draft.selected.filter((choice) => choice !== action.choice)
    return {
      ...draft,
      selected:
        toggledOff.length < draft.selected.length ? toggledOff : [...draft.selected, action.choice],
    }
  }
  // Confirm is meaningful only on a multiSelect step with something chosen —
  // an empty set is not an answer.
  if (!current.multiSelect || draft.selected.length === 0) return draft
  return { step: draft.step + 1, answers: [...draft.answers, draft.selected], selected: [] }
}

/**
 * @param {readonly QuestionSpec[]} questions
 * @param {QuestionDraft} draft
 * @returns {readonly (readonly string[])[] | null} the complete answer set to
 *   post, or null while questions remain
 */
export function draftAnswers(questions, draft) {
  return draft.answers.length === questions.length ? draft.answers : null
}

/**
 * Queue-depth badge for the takeover: the visible card is prompts[0], so the
 * badge counts what waits behind it and disappears when nothing does.
 *
 * @param {readonly PendingPrompt[]} prompts
 * @returns {string} badge text, empty when the queue has drained
 */
export function queueBadge(prompts) {
  const waiting = prompts.length - 1
  return waiting > 0 ? `+${waiting} QUEUED` : ''
}

/** D15: long enough to stop a brush, short enough not to punish every allow. */
export const ALLOW_HOLD_MS = 500

/** D15: a destructive command must take a hold no accident can complete. */
export const HIGH_RISK_ALLOW_HOLD_MS = 1500

/**
 * @param {'high' | 'routine'} risk
 * @returns {number} how long the Allow button must be held to fill
 */
export function allowHoldMs(risk) {
  return risk === 'high' ? HIGH_RISK_ALLOW_HOLD_MS : ALLOW_HOLD_MS
}

// Slow orbit around center; every OLED pixel under the layout gets rest.
const AMBIENT_ORBIT = Object.freeze([
  { x: 0, y: 0 },
  { x: 4, y: -2 },
  { x: 7, y: 2 },
  { x: 4, y: 5 },
  { x: 0, y: 7 },
  { x: -4, y: 5 },
  { x: -7, y: 2 },
  { x: -4, y: -2 },
  { x: 0, y: -5 },
])

/**
 * @param {number} minuteIndex
 * @returns {{ x: number, y: number }} whole-pixel layout offset for this minute
 */
export function ambientShift(minuteIndex) {
  return AMBIENT_ORBIT[Math.abs(minuteIndex) % AMBIENT_ORBIT.length] ?? { x: 0, y: 0 }
}

/** How long Clawd waves back at a fresh handshake before resuming his day. */
export const HANDSHAKE_WAVE_MS = 4_000

/**
 * The install's proof-of-pipeline ping earns a bounded wave — but only when it
 * is news. Reconnect replay redelivers history (at-least-once), and an old
 * handshake waving again would be a lie, so age gates it exactly like
 * completionAlert's MAX_ALERT_AGE_MS.
 *
 * @param {{ type: string, at: number }} event with `at` already rebased onto
 *   this device's clock (localEventTime)
 * @param {number} receiptNow this device's clock at receipt
 * @returns {number | null} wave-until timestamp, or null when nothing waves
 */
export function handshakeWave(event, receiptNow) {
  if (event.type !== 'handshake') return null
  if (receiptNow - event.at > MAX_ALERT_AGE_MS) return null
  return receiptNow + HANDSHAKE_WAVE_MS
}

/**
 * @typedef {'sleeping' | 'typing' | 'waving' | 'alarmed' | 'paused' | 'offline'} ClawdPose
 */

/**
 * Clawd acts out the deck state so it reads from peripheral vision.
 *
 * @param {DeckView} view
 * @param {boolean} [promptPending] a takeover card is up
 * @param {boolean} [waving] a fresh handshake's bounded wave (handshakeWave)
 * @returns {ClawdPose}
 */
export function clawdPose(view, promptPending = false, waving = false) {
  // Same precedence as the accents: offline owns the pose outright (a card a
  // dead stream can't answer must not beckon), then the waiting prompt, then
  // the handshake wave (short-lived and made to be seen — it outranks the
  // paused readout but never urgency), then the paused overlay, then whatever
  // the session is doing.
  if (view.mode === 'offline') return 'offline'
  if (promptPending) return 'alarmed'
  if (waving) return 'waving'
  if (view.paused) return 'paused'
  if (view.mode === 'running') return 'typing'
  if (view.mode === 'done') return 'waving'
  return 'sleeping'
}

/**
 * The speech bubble's lifetime, derived from the mascot's pose — the single
 * source of truth, not a timer or a Stop event. Clawd speaks exactly while he
 * types (a session is running); any other pose (waving, sleeping, alarmed,
 * paused, offline) clears the bubble in the same beat the pose changes.
 *
 * @param {ClawdPose} pose
 * @returns {boolean}
 */
export function bubbleVisible(pose) {
  return pose === 'typing'
}

/**
 * The centered SLOPDECK title steps aside while the bubble speaks and returns
 * when the deck is at rest — the exact inverse of the bubble, so the two can
 * never both own the top of the deck.
 *
 * @param {ClawdPose} pose
 * @returns {boolean}
 */
export function titleVisible(pose) {
  return !bubbleVisible(pose)
}

/**
 * @typedef {{ mode: DeckView['mode'], paused: boolean, promptPending: boolean }} DeckSignature
 * @typedef {'crt' | 'wipe'} DeckTransition
 */

/**
 * The deck's visible state, reduced to what a transition can be judged on.
 *
 * @param {DeckView} view
 * @param {boolean} promptPending a takeover card is up
 * @returns {DeckSignature}
 */
export function deckSignature(view, promptPending) {
  return { mode: view.mode, paused: view.paused === true, promptPending }
}

/** D17: the everyday stripe-wipe — brisk enough to never delay legibility. */
export const STRIPE_WIPE_MS = 400

/** D17: the full multi-stripe CRT ceremony still lands inside the budget. */
export const CRT_CHOREO_MS = 560

/**
 * D17: which choreography a state change earns. The full CRT choreography
 * fires on exactly one event — prompt arrival.
 *
 * @param {DeckSignature} before
 * @param {DeckSignature} after
 * @returns {DeckTransition | null}
 */
export function deckTransition(before, after) {
  if (!before.promptPending && after.promptPending) return 'crt'
  const changed =
    before.mode !== after.mode ||
    before.paused !== after.paused ||
    before.promptPending !== after.promptPending
  return changed ? 'wipe' : null
}

// Every brand asset — starburst icon, Clawd sprites — resolves through this
// one directory. A rebrand is an asset swap behind these tokens, never a
// component-code change.
const BRAND_DIR = '/brand'

/**
 * @param {string} name
 * @returns {string} URL path of a brand asset
 */
export function brandAsset(name) {
  return `${BRAND_DIR}/${name}`
}

/**
 * @param {ClawdPose} pose
 * @returns {string} URL path of the sprite acting out this pose
 */
export function clawdSprite(pose) {
  return brandAsset(`clawd-${pose}.svg`)
}

/** @param {number} value */
function pad(value) {
  return String(value).padStart(2, '0')
}

/**
 * @param {number} elapsedMs
 * @returns {string} `MM:SS` under an hour, `H:MM:SS` beyond, never negative.
 */
export function formatElapsed(elapsedMs) {
  const totalSeconds = Math.max(0, Math.floor(elapsedMs / 1000))
  const hours = Math.floor(totalSeconds / 3600)
  const minutes = Math.floor((totalSeconds % 3600) / 60)
  const seconds = totalSeconds % 60
  return hours > 0 ? `${hours}:${pad(minutes)}:${pad(seconds)}` : `${pad(minutes)}:${pad(seconds)}`
}

/**
 * @param {Date} date
 * @returns {string} zero-padded 24h `HH:MM`
 */
export function formatTimeOfDay(date) {
  return `${pad(date.getHours())}:${pad(date.getMinutes())}`
}

/**
 * D17: the idle clock's 1Hz colon pulse — visible one half-second, hidden the
 * next. The hidden colon becomes a space so the digits never shift column.
 *
 * @param {string} text a clock string like `14:05`
 * @param {number} now
 * @returns {string}
 */
export function pulseColon(text, now) {
  return Math.floor(now / 500) % 2 === 0 ? text : text.replace(':', ' ')
}

/**
 * Phone pairing via URL fragment: `#deck-token=<token>`. Fragments never
 * travel in HTTP requests, so the token cannot reach server or proxy logs.
 *
 * @param {string} hash `location.hash` as the browser reports it
 * @returns {string | null} the token, or null when the fragment is not a pairing fragment
 */
export function fragmentToken(hash) {
  if (!hash.startsWith('#deck-token=')) return null
  try {
    const token = decodeURIComponent(hash.slice('#deck-token='.length))
    return token === '' ? null : token
  } catch {
    // Malformed percent-encoding — not a pairing fragment we can honor.
    return null
  }
}
