// Pure deck state machine, shared verbatim between the browser (served as a
// static module, no build step) and vitest — which is why this file is plain
// JS with JSDoc types instead of TypeScript.

/**
 * @typedef {{ type: 'prompt' | 'stop', sessionId: string, title: string, at: number }} DeckEvent
 * @typedef {{ status: 'running', title: string, since: number }} RunningSession
 * @typedef {{ status: 'done', title: string, elapsedMs: number | null }} DoneSession
 * @typedef {RunningSession | DoneSession} SessionState
 * @typedef {{ activeSessionId: string | null, sessions: Readonly<Record<string, SessionState>> }} DeckState
 * @typedef {{ mode: 'idle' }
 *   | { mode: 'running', title: string, elapsedMs: number }
 *   | { mode: 'done', title: string, elapsedMs: number | null }
 *   | { mode: 'offline' }} DeckView
 */

/** @type {DeckState} */
export const initialDeckState = Object.freeze({ activeSessionId: null, sessions: Object.freeze({}) })

/**
 * @param {DeckState} state
 * @param {DeckEvent} event
 * @returns {DeckState}
 */
export function reduceDeck(state, event) {
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
    activeSessionId: event.sessionId,
    sessions: { ...state.sessions, [event.sessionId]: session },
  }
}

/**
 * @param {DeckState} state
 * @param {number} now
 * @param {{ connected?: boolean }} [connection] A down stream always projects
 *   offline — a stale clock is a lie the deck must never tell.
 * @returns {DeckView}
 */
export function deckView(state, now, { connected = true } = {}) {
  if (!connected) return { mode: 'offline' }
  const active = state.activeSessionId === null ? undefined : state.sessions[state.activeSessionId]
  if (active === undefined) return { mode: 'idle' }
  if (active.status === 'running') {
    return { mode: 'running', title: active.title, elapsedMs: now - active.since }
  }
  return { mode: 'done', title: active.title, elapsedMs: active.elapsedMs }
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
 * @typedef {{ key: string, tool: string, detail: string, risk: 'highlighted' | 'routine', at: number }} TickerRow
 */

/** @type {readonly TickerRow[]} */
export const initialTicker = Object.freeze([])

// A desk-clock strip shows a handful of rows; 20 covers a taller layout
// while keeping the always-on DOM small.
const TICKER_CAPACITY = 20

/**
 * @param {readonly TickerRow[]} ticker newest row first
 * @param {{ type: string, id: number, at: number, bootId?: string, sessionId?: string,
 *   title?: string, tool?: string, detail?: string, risk?: string }} event a deck SSE
 *   frame — external JSON, so tool fields are normalized here rather than trusted.
 * @returns {readonly TickerRow[]}
 */
export function reduceTicker(ticker, event) {
  if (event.type !== 'tool') return ticker
  // Reconnect replay is at-least-once; the audit strip must stay exactly-once.
  // Keyed by (bootId, id): a restarted gateway reuses ids from 1, and those
  // collisions are new events, not duplicates.
  const key = `${event.bootId ?? ''}:${event.id}`
  if (ticker.some((row) => row.key === key)) return ticker
  const row = {
    key,
    tool: String(event.tool ?? ''),
    detail: String(event.detail ?? ''),
    risk: event.risk === 'highlighted' ? /** @type {const} */ ('highlighted') : /** @type {const} */ ('routine'),
    at: event.at,
  }
  return [row, ...ticker].slice(0, TICKER_CAPACITY)
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
