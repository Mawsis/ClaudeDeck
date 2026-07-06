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
 * @typedef {'high' | 'highlighted' | 'routine'} BubbleRisk the three ambient
 *   tiers, mapped 1:1 to the bash-classifier and preserved end-to-end — the
 *   ticker flattened `high` into `highlighted`; the bubble must not.
 * @typedef {'empty' | 'verb' | 'command'} BubblePhase which face the bubble
 *   shows: `empty` before a turn (and after a handshake — nothing to say),
 *   `verb` between prompt-submit and the turn's first command (the cycling
 *   thinking verb), `command` once a tool has landed (the held command line).
 * @typedef {{ phase: BubblePhase, key: string, tool: string, detail: string,
 *   category: string, risk: BubbleRisk, project: string }} BubbleState what
 *   Clawd is saying: the phase, the held command's dedup key, the raw line the
 *   gateway extracted (command head for Bash, cwd-relative path for edits), the
 *   classifier category driving the label, the risk tier driving the color,
 *   and the project the bubble belongs to.
 */

/** The tier the bubble falls back to for anything that is not a known tier —
 * external JSON is never trusted to carry a valid one. */
const BUBBLE_RISK_TIERS = Object.freeze(['high', 'highlighted', 'routine'])

/**
 * @param {unknown} risk
 * @returns {BubbleRisk}
 */
function normalizeRisk(risk) {
  return BUBBLE_RISK_TIERS.includes(/** @type {BubbleRisk} */ (risk))
    ? /** @type {BubbleRisk} */ (risk)
    : 'routine'
}

/** @type {BubbleState} An empty bubble — nothing said yet. */
export const initialBubble = Object.freeze({
  phase: 'empty',
  key: '',
  tool: '',
  detail: '',
  category: 'routine',
  risk: 'routine',
  project: '',
})

/**
 * The bubble runs a three-phase turn machine, all in this one reducer:
 *
 * - `prompt` opens the verb window — but only from `empty`, i.e. the turn's
 *   first prompt. A prompt that arrives while a command is already held is a
 *   mid-turn continuation (reduceDeck treats it the same), so the truthfully
 *   running command stays put rather than being papered over with a verb.
 * - `tool` holds the latest command and ends the verb window. There is no
 *   history and no linger timer — the pose owns visibility (bubbleVisible);
 *   this reducer only ever swaps in the true latest command.
 * - `stop` ends the turn, returning the bubble to `empty` so the *next* prompt
 *   can reopen the verb window. The pose already hides the bubble on stop, so
 *   the just-finished command was invisible anyway — this only rearms the verb.
 * - `handshake`, `mode`, and every other frame leave the bubble untouched: the
 *   install ping fires with no running session, so it must never masquerade as
 *   a command or a think.
 *
 * @param {BubbleState} bubble
 * @param {{ type: string, id: number, bootId?: string, tool?: string,
 *   detail?: string, category?: string, risk?: string, title?: string }} event
 *   a deck SSE frame — external JSON, so tool fields are normalized here rather
 *   than trusted.
 * @returns {BubbleState}
 */
export function reduceBubble(bubble, event) {
  // The turn's first prompt opens the verb window; a mid-turn prompt (bubble
  // already past empty) is a continuation and leaves the held command alone.
  if (event.type === 'prompt') {
    if (bubble.phase !== 'empty') return bubble
    return { ...initialBubble, phase: 'verb', project: String(event.title ?? '') }
  }
  // A stop closes the turn back to empty — nothing to say, and the next
  // prompt's verb window is armed. Already empty means nothing changed.
  if (event.type === 'stop') {
    return bubble.phase === 'empty' ? bubble : initialBubble
  }
  if (event.type !== 'tool') return bubble
  // Reconnect replay is at-least-once; the bubble must reflect the true latest
  // command, not a replayed older one. Keyed by (bootId, id) exactly as the
  // ticker did: a restarted gateway reuses ids from 1, so those collisions are
  // new events, not duplicates. Dedup is exact-key only — the latest command is
  // whichever frame arrives last, which is load-bearing on the gateway
  // replaying its ring buffer in ascending id order (event-log.ts). An
  // out-of-order source would let an older frame clobber a newer one.
  const key = `${event.bootId ?? ''}:${event.id}`
  if (key === bubble.key) return bubble
  // All three risk tiers ride onto the bubble intact (unlike the ticker, which
  // flattened `high` into `highlighted`); the project is the tool frame's
  // title — the cwd basename the gateway already derived. The first command of
  // a turn ends the verb window; the phase becomes `command`.
  return {
    phase: 'command',
    key,
    tool: String(event.tool ?? ''),
    detail: String(event.detail ?? ''),
    category: String(event.category ?? 'routine'),
    risk: normalizeRisk(event.risk),
    project: String(event.title ?? ''),
  }
}

/**
 * Claude Code's published thinking verbs — the words the CLI's spinner cycles
 * while Claude reasons before its first tool call. Kept alphabetical (from
 * `Accomplishing` to `Zesting`) so the range is legible and the bookends are
 * verifiable; frozen so no caller can reorder it and silently shift the picker.
 * @type {readonly string[]}
 */
export const SPINNER_VERBS = Object.freeze([
  'Accomplishing', 'Actioning', 'Actualizing', 'Aligning', 'Analyzing',
  'Architecting', 'Arranging', 'Assembling', 'Baking', 'Bamboozling',
  'Bippizadooling', 'Booping', 'Bopping', 'Brainstorming', 'Brewing',
  'Buffering', 'Building', 'Bungeeing', 'Calculating', 'Calibrating',
  'Cerebrating', 'Channelling', 'Charging', 'Churning', 'Clauding',
  'Coalescing', 'Cogitating', 'Combobulating', 'Composing', 'Computing',
  'Concocting', 'Conjuring', 'Considering', 'Constructing', 'Contemplating',
  'Cooking', 'Crafting', 'Cranking', 'Creating', 'Crunching', 'Deciphering',
  'Decoding', 'Deliberating', 'Delving', 'Designing', 'Determining',
  'Devising', 'Digesting', 'Discombobulating', 'Distilling', 'Divining',
  'Doing', 'Dreaming', 'Effecting', 'Elaborating', 'Elucidating',
  'Enchanting', 'Engineering', 'Envisioning', 'Establishing', 'Evaluating',
  'Exploring', 'Fabricating', 'Fashioning', 'Fathoming', 'Fermenting',
  'Fiddling', 'Figuring', 'Finagling', 'Finessing', 'Flibbertigibbeting',
  'Flourishing', 'Focusing', 'Forging', 'Formulating', 'Frolicking',
  'Gathering', 'Generating', 'Germinating', 'Gestating', 'Grokking',
  'Hatching', 'Herding', 'Honking', 'Hustling', 'Hypothesizing', 'Ideating',
  'Illuminating', 'Imagining', 'Incubating', 'Inferring', 'Ingesting',
  'Inspecting', 'Interpreting', 'Inventing', 'Jamming', 'Jiving',
  'Juggling', 'Kneading', 'Knitting', 'Ludicrousing', 'Machinating',
  'Manifesting', 'Marinating', 'Massaging', 'Meandering', 'Moseying',
  'Mulching', 'Mulling', 'Mustering', 'Musing', 'Navigating', 'Noodling',
  'Optimizing', 'Orchestrating', 'Organizing', 'Percolating', 'Percussing',
  'Perusing', 'Philosophising', 'Pinging', 'Plotting', 'Pondering',
  'Pontificating', 'Prancing', 'Preparing', 'Processing', 'Producing',
  'Puttering', 'Puzzling', 'Quantifying', 'Querying', 'Questing',
  'Ratiocinating', 'Reasoning', 'Reconciling', 'Reticulating', 'Rooting',
  'Ruminating', 'Rustling', 'Scaffolding', 'Scheming', 'Schlepping',
  'Sculpting', 'Shimmying', 'Shucking', 'Simmering', 'Sketching', 'Smooshing',
  'Sorting', 'Spelunking', 'Spinning', 'Sprinkling', 'Sprouting', 'Squinting',
  'Stewing', 'Strategizing', 'Structuring', 'Summoning', 'Surveying',
  'Sussing', 'Synthesizing', 'Tabulating', 'Thinkerating', 'Thinking',
  'Tinkering', 'Toiling', 'Transfiguring', 'Transmuting', 'Traversing',
  'Trundling', 'Unfurling', 'Unpacking', 'Unravelling', 'Untangling',
  'Vibing', 'Visualizing', 'Wandering', 'Weaving', 'Whirring', 'Whisking',
  'Wibbling', 'Wizarding', 'Working', 'Wrangling', 'Wrestling', 'Yak-shaving',
  'Zesting',
])

/**
 * Pick a thinking verb for a given seed. The seed is the render tick — the
 * caller injects `Math.floor(Date.now() / VERB_CYCLE_MS)` exactly as the deck
 * injects `now` into `deckView`, so verb selection stays pure while the ~1.5s
 * cadence lives entirely in the projection. `Math.abs` keeps a negative or
 * fractional seed on the list; a non-finite seed falls back to the first verb
 * rather than reading `undefined` off the array.
 *
 * @param {number} seed the render tick — an integer index the caller advances
 * @returns {string} the verb for this tick
 */
export function spinnerVerb(seed) {
  // The list is a non-empty frozen literal and the index is a modulo of its
  // length, so the read is always in bounds; the `?? 'Thinking'` coalesce only
  // satisfies noUncheckedIndexedAccess and doubles as the non-finite fallback.
  const index = Number.isFinite(seed) ? Math.abs(Math.floor(seed)) % SPINNER_VERBS.length : 0
  return SPINNER_VERBS[index] ?? 'Thinking'
}

/** The verb window's cycle time: the CLI's TUI advances its spinner word about
 * every 1.5s, so the deck matches that cadence. The projection turns the wall
 * clock into a seed with `Math.floor(now / VERB_CYCLE_MS)` — one integer step
 * per cycle — and hands it to bubbleVerbLine. */
export const VERB_CYCLE_MS = 1_500

/**
 * The line the bubble shows during the verb window: the cycling thinking verb
 * with a trailing ellipsis, so it reads as a thought in progress (`Pondering…`)
 * rather than a finished label. The seed is the render tick the projection
 * injects — the same clock-at-the-boundary discipline as `spinnerVerb` — so the
 * ~1.5s cadence lives in the caller, and this stays pure and pinnable.
 *
 * @param {number} seed the render tick (`Math.floor(now / VERB_CYCLE_MS)`)
 * @returns {string}
 */
export function bubbleVerbLine(seed) {
  return `${spinnerVerb(seed)}…`
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
 * The bubble is one fixed-height line: the CSS clamps the visible width with a
 * text-overflow ellipsis, but the data must not ship an unbounded string into
 * the DOM, and the cut must fall on a code-point boundary — a split surrogate
 * pair leaves a broken glyph the browser can't repair. Wider than any viewport
 * shows, so the CSS still owns the visual ellipsis; this only bounds the string.
 */
export const BUBBLE_LINE_MAX = 120

/**
 * `slice()` counts UTF-16 units and can cut a surrogate pair in half. Clamp on
 * code points instead, mirroring the gateway's clampCodePoints: the unit-level
 * pre-slice keeps Array.from off a pathologically long line, and the +1 spare
 * unit covers the cap landing inside the last pair.
 *
 * @param {string} text
 * @param {number} max
 * @returns {string}
 */
function clampCodePoints(text, max) {
  if (text.length <= max) return text
  const points = Array.from(text.slice(0, max * 2 + 1))
  return points.length <= max ? points.join('') : points.slice(0, max).join('')
}

/** The a3-hybrid separator between the scannable category label and the raw
 * command tail — a middle dot padded so it reads as one line, not a path. */
const LABEL_SEPARATOR = ' · '

/**
 * The fixed label copy per classifier category, plus the leading verb to strip
 * off the tail so it does not echo the label (`git push · origin main`, not
 * `git push · git push origin main`). Categories carrying `high` risk lead with
 * a ⚠ so the danger reads even in monochrome. The `strip` regex is anchored at
 * the tail's start and only fires when the command actually begins with that
 * verb — a compound command (`cd app && npm install`) keeps its whole tail,
 * since there is no leading verb to lift. `routine` and `edit` are absent: they
 * carry no label and fall through to the raw line.
 */
const CATEGORY_LABELS = Object.freeze({
  'git-push': { label: 'git push', strip: /^git\s+push\s+/ },
  'force-push': { label: '⚠ git push --force', strip: /^git\s+push\s+(?:--force(?:-with-lease)?|-\w*f\b)\s+/ },
  'package-install': { label: 'installing', strip: /^(?:npm|pnpm|yarn|bun|pip3?|brew|apt|apt-get|gem|cargo|composer)\s+(?:i|install|add|require)\s+/ },
  migration: { label: '⚠ db migration', strip: null },
  deploy: { label: '⚠ deploying', strip: null },
  docker: { label: 'docker', strip: /^docker(?:-compose)?(?:\s+|$)/ },
  'destructive-delete': { label: '⚠ rm -rf', strip: /^rm\s+(?:-\w*[rfR]\S*|--(?:recursive|force))\s+/ },
})

/**
 * The file-edit tools carry a known, redundant verb — the path already says the
 * rest — so the verb renders as a short colored prefix, split by intent: a write
 * (creating/overwriting a whole file) reads `write`, an in-place change reads
 * `edit`. Bash is absent: it carries the classifier label system instead, so it
 * shows no verb. The value is the `data-verb` color tier (`write` red, `edit`
 * yellow), driven off CSS the same way `data-risk` colors the line.
 */
const EDIT_TOOL_VERBS = Object.freeze({
  Write: { label: 'write', tier: 'write' },
  Edit: { label: 'edit', tier: 'edit' },
  MultiEdit: { label: 'edit', tier: 'edit' },
  NotebookEdit: { label: 'edit', tier: 'edit' },
})

/**
 * The colored verb prefix for the held command, or null when there is none (Bash
 * and any unmapped tool). Rendered in its own span so the verb carries the color
 * and the path stays neutral — kept separate from bubbleLine so each is set via
 * textContent and an untrusted detail never becomes markup.
 *
 * @param {BubbleState} bubble
 * @returns {{ label: string, tier: string } | null}
 */
export function bubbleVerb(bubble) {
  if (bubble.phase !== 'command') return null
  const verb = EDIT_TOOL_VERBS[/** @type {keyof typeof EDIT_TOOL_VERBS} */ (bubble.tool)]
  return verb === undefined ? null : { label: verb.label, tier: verb.tier }
}

/**
 * Clamp a composed line to the one-line budget with a trailing ellipsis, only
 * on a real cut — a line that fits is returned verbatim. Code-point counted so
 * astral glyphs aren't cut early and the fit test matches the clamp.
 *
 * @param {string} line
 * @returns {string}
 */
function clampBubbleLine(line) {
  if (Array.from(line).length <= BUBBLE_LINE_MAX) return line
  return `${clampCodePoints(line, BUBBLE_LINE_MAX)}…`
}

/**
 * The single line the bubble shows for the held command. Three shapes, all
 * clamped to the bubble's fixed one-line budget with a trailing ellipsis:
 * - a classified high-impact Bash command becomes `LABEL · tail`, where the
 *   label is the scannable category and the tail is the raw command with the
 *   labeled verb lifted off so it doesn't echo (a3 hybrid);
 * - routine Bash and the edit tools show the raw line the gateway extracted,
 *   untouched (command head or cwd-relative path).
 * Truncation lands on the composed label+tail, never the raw command alone, so
 * the label is never what gets cut.
 *
 * @param {BubbleState} bubble
 * @returns {string}
 */
export function bubbleLine(bubble) {
  const labeled = CATEGORY_LABELS[/** @type {keyof typeof CATEGORY_LABELS} */ (bubble.category)]
  if (labeled === undefined) return clampBubbleLine(bubble.detail)
  // Lift the labeled verb off the front only when the command actually starts
  // with it; a buried match (compound command) keeps its whole tail.
  const tail = labeled.strip ? bubble.detail.replace(labeled.strip, '') : bubble.detail
  // A stripped-to-empty tail (a bare `docker`) shows the label alone — never a
  // dangling `docker · ` separator with nothing after it.
  const line = tail === '' ? labeled.label : `${labeled.label}${LABEL_SEPARATOR}${tail}`
  return clampBubbleLine(line)
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
