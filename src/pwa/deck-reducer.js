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
 *   | { mode: 'done', title: string, elapsedMs: number | null }} DeckView
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
 * @returns {DeckView}
 */
export function deckView(state, now) {
  const active = state.activeSessionId === null ? undefined : state.sessions[state.activeSessionId]
  if (active === undefined) return { mode: 'idle' }
  if (active.status === 'running') {
    return { mode: 'running', title: active.title, elapsedMs: now - active.since }
  }
  return { mode: 'done', title: active.title, elapsedMs: active.elapsedMs }
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
