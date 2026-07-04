import { describe, expect, it } from 'vitest'
import {
  ambientShift,
  completionAlert,
  deckView,
  firstRunHint,
  formatElapsed,
  formatTimeOfDay,
  initialDeckState,
  localEventTime,
  reduceDeck,
  runningCountBadge,
  runningSessionCount,
} from '../src/pwa/deck-reducer.js'

describe('deck reducer', () => {
  it('projects idle before any event arrives', () => {
    expect(deckView(initialDeckState, 5_000)).toEqual({ mode: 'idle' })
  })

  it('flips to running with the session label on a prompt event and counts elapsed from it', () => {
    const state = reduceDeck(initialDeckState, {
      type: 'prompt',
      sessionId: 's1',
      title: 'my-app',
      at: 10_000,
    })

    expect(deckView(state, 71_000)).toEqual({ mode: 'running', title: 'my-app', elapsedMs: 61_000 })
  })

  it('freezes the timer on stop — the view stops advancing with the clock', () => {
    const running = reduceDeck(initialDeckState, {
      type: 'prompt',
      sessionId: 's1',
      title: 'my-app',
      at: 10_000,
    })
    const done = reduceDeck(running, { type: 'stop', sessionId: 's1', title: 'my-app', at: 95_000 })

    const view = { mode: 'done', title: 'my-app', elapsedMs: 85_000 }
    expect(deckView(done, 95_000)).toEqual(view)
    expect(deckView(done, 999_000)).toEqual(view)
  })

  it('shows whichever session most recently emitted an event, without losing the others', () => {
    const events = [
      { type: 'prompt', sessionId: 'a', title: 'alpha', at: 1_000 },
      { type: 'prompt', sessionId: 'b', title: 'beta', at: 5_000 },
      { type: 'stop', sessionId: 'a', title: 'alpha', at: 31_000 },
    ] as const

    let state = initialDeckState
    state = reduceDeck(state, events[0])
    expect(deckView(state, 2_000)).toMatchObject({ mode: 'running', title: 'alpha' })

    state = reduceDeck(state, events[1])
    expect(deckView(state, 6_000)).toEqual({ mode: 'running', title: 'beta', elapsedMs: 1_000 })

    state = reduceDeck(state, events[2])
    expect(deckView(state, 31_000)).toEqual({ mode: 'done', title: 'alpha', elapsedMs: 30_000 })

    const laterPrompt = reduceDeck(state, {
      type: 'prompt',
      sessionId: 'b',
      title: 'beta',
      at: 40_000,
    })
    expect(deckView(laterPrompt, 41_000)).toMatchObject({ mode: 'running', title: 'beta' })
  })

  it('keeps the original start when a prompt is queued mid-turn — the timer never resets while running', () => {
    const running = reduceDeck(initialDeckState, {
      type: 'prompt',
      sessionId: 's1',
      title: 'my-app',
      at: 10_000,
    })
    const queued = reduceDeck(running, {
      type: 'prompt',
      sessionId: 's1',
      title: 'my-app',
      at: 50_000,
    })

    expect(deckView(queued, 60_000)).toEqual({ mode: 'running', title: 'my-app', elapsedMs: 50_000 })
  })

  it('keeps the frozen duration when a stop is delivered twice', () => {
    const running = reduceDeck(initialDeckState, {
      type: 'prompt',
      sessionId: 's1',
      title: 'my-app',
      at: 10_000,
    })
    const done = reduceDeck(running, { type: 'stop', sessionId: 's1', title: 'my-app', at: 20_000 })
    const redelivered = reduceDeck(done, {
      type: 'stop',
      sessionId: 's1',
      title: 'my-app',
      at: 25_000,
    })

    expect(deckView(redelivered, 25_000)).toEqual({ mode: 'done', title: 'my-app', elapsedMs: 10_000 })
  })

  it('projects offline instead of a stale clock while the stream is down, even mid-session', () => {
    const running = reduceDeck(initialDeckState, {
      type: 'prompt',
      sessionId: 's1',
      title: 'my-app',
      at: 10_000,
    })

    expect(deckView(running, 60_000, { connected: false })).toEqual({ mode: 'offline' })
    expect(deckView(initialDeckState, 60_000, { connected: false })).toEqual({ mode: 'offline' })
  })

  it('returns to the truthful view the moment the stream is back', () => {
    const running = reduceDeck(initialDeckState, {
      type: 'prompt',
      sessionId: 's1',
      title: 'my-app',
      at: 10_000,
    })

    expect(deckView(running, 60_000, { connected: true })).toEqual({
      mode: 'running',
      title: 'my-app',
      elapsedMs: 50_000,
    })
  })

  it('reports an unknown duration for a stop with no observed prompt', () => {
    const state = reduceDeck(initialDeckState, {
      type: 'stop',
      sessionId: 's1',
      title: 'my-app',
      at: 10_000,
    })

    expect(deckView(state, 10_000)).toEqual({ mode: 'done', title: 'my-app', elapsedMs: null })
  })

  it('flags paused after a pause mode event without stopping the session clock underneath', () => {
    const running = reduceDeck(initialDeckState, {
      type: 'prompt',
      sessionId: 's1',
      title: 'my-app',
      at: 10_000,
    })
    const paused = reduceDeck(running, { type: 'mode', paused: true, at: 20_000 })

    // D5: pausing flips interception, not the timer — the clock keeps counting.
    // D14: purple paused accent overlays whatever session is active.
    expect(deckView(paused, 70_000)).toEqual({
      mode: 'running',
      title: 'my-app',
      elapsedMs: 60_000,
      paused: true,
    })
  })

  it('does not flag paused while intercepting — the default view carries no paused key', () => {
    const running = reduceDeck(initialDeckState, {
      type: 'prompt',
      sessionId: 's1',
      title: 'my-app',
      at: 10_000,
    })

    expect(deckView(running, 70_000)).toEqual({
      mode: 'running',
      title: 'my-app',
      elapsedMs: 60_000,
    })
  })

  it('clears the paused flag when the mode flips back to intercept', () => {
    let state = reduceDeck(initialDeckState, {
      type: 'prompt',
      sessionId: 's1',
      title: 'my-app',
      at: 10_000,
    })
    state = reduceDeck(state, { type: 'mode', paused: true, at: 20_000 })
    state = reduceDeck(state, { type: 'mode', paused: false, at: 30_000 })

    expect(deckView(state, 70_000)).toEqual({
      mode: 'running',
      title: 'my-app',
      elapsedMs: 60_000,
    })
  })

  it('lets offline win over paused — a stale clock is a worse lie than a stale accent', () => {
    let state = reduceDeck(initialDeckState, {
      type: 'prompt',
      sessionId: 's1',
      title: 'my-app',
      at: 10_000,
    })
    state = reduceDeck(state, { type: 'mode', paused: true, at: 20_000 })

    expect(deckView(state, 70_000, { connected: false })).toEqual({ mode: 'offline' })
  })

  it('flags paused even while idle — the mode is set before any session runs', () => {
    const paused = reduceDeck(initialDeckState, { type: 'mode', paused: true, at: 5_000 })

    expect(deckView(paused, 10_000)).toEqual({ mode: 'idle', paused: true })
  })
})

describe('running-session count', () => {
  it('counts sessions with a prompt and no stop yet, across interleaved sessions', () => {
    let state = initialDeckState
    expect(runningSessionCount(state)).toBe(0)

    state = reduceDeck(state, { type: 'prompt', sessionId: 'a', title: 'alpha', at: 1_000 })
    expect(runningSessionCount(state)).toBe(1)

    state = reduceDeck(state, { type: 'prompt', sessionId: 'b', title: 'beta', at: 2_000 })
    expect(runningSessionCount(state)).toBe(2)

    state = reduceDeck(state, { type: 'stop', sessionId: 'a', title: 'alpha', at: 3_000 })
    expect(runningSessionCount(state)).toBe(1)

    state = reduceDeck(state, { type: 'stop', sessionId: 'b', title: 'beta', at: 4_000 })
    expect(runningSessionCount(state)).toBe(0)
  })

  it('never counts sessions that only ever stopped or paused — done and mode events are not running work', () => {
    let state = reduceDeck(initialDeckState, {
      type: 'stop',
      sessionId: 'ghost',
      title: 'ghost',
      at: 1_000,
    })
    state = reduceDeck(state, { type: 'mode', paused: true, at: 2_000 })

    expect(runningSessionCount(state)).toBe(0)
  })

  it('counts a session once no matter how many prompts queue mid-turn', () => {
    let state = reduceDeck(initialDeckState, {
      type: 'prompt',
      sessionId: 'a',
      title: 'alpha',
      at: 1_000,
    })
    state = reduceDeck(state, { type: 'prompt', sessionId: 'a', title: 'alpha', at: 2_000 })

    expect(runningSessionCount(state)).toBe(1)
  })

  it('renders as a dim badge only while at least one session runs — hidden entirely at zero', () => {
    expect(runningCountBadge(initialDeckState)).toBe('')

    const one = reduceDeck(initialDeckState, {
      type: 'prompt',
      sessionId: 'a',
      title: 'alpha',
      at: 1_000,
    })
    expect(runningCountBadge(one)).toBe('×1')

    const two = reduceDeck(one, { type: 'prompt', sessionId: 'b', title: 'beta', at: 2_000 })
    expect(runningCountBadge(two)).toBe('×2')

    let drained = reduceDeck(two, { type: 'stop', sessionId: 'a', title: 'alpha', at: 3_000 })
    drained = reduceDeck(drained, { type: 'stop', sessionId: 'b', title: 'beta', at: 4_000 })
    expect(runningCountBadge(drained)).toBe('')
  })
})

describe('first-run hint', () => {
  it('shows only while the log has never contained a session event', () => {
    expect(firstRunHint(initialDeckState)).toBe(true)

    const prompted = reduceDeck(initialDeckState, {
      type: 'prompt',
      sessionId: 'a',
      title: 'alpha',
      at: 1_000,
    })
    expect(firstRunHint(prompted)).toBe(false)
  })

  it('treats a bare stop as a session event too — replay may start mid-session', () => {
    const stopped = reduceDeck(initialDeckState, {
      type: 'stop',
      sessionId: 'a',
      title: 'alpha',
      at: 1_000,
    })

    expect(firstRunHint(stopped)).toBe(false)
  })

  it('is not fooled by mode events — pausing an empty deck is not a session', () => {
    const paused = reduceDeck(initialDeckState, { type: 'mode', paused: true, at: 1_000 })

    expect(firstRunHint(paused)).toBe(true)
  })

  it('never returns once a session has been seen, whatever arrives after', () => {
    let state = reduceDeck(initialDeckState, {
      type: 'prompt',
      sessionId: 'a',
      title: 'alpha',
      at: 1_000,
    })
    state = reduceDeck(state, { type: 'stop', sessionId: 'a', title: 'alpha', at: 2_000 })
    state = reduceDeck(state, { type: 'mode', paused: true, at: 3_000 })
    state = reduceDeck(state, { type: 'mode', paused: false, at: 4_000 })

    expect(firstRunHint(state)).toBe(false)
  })
})

describe('completion alerts', () => {
  it('decides a push alert for a longer-than-threshold turn while the deck is hidden', () => {
    const running = reduceDeck(initialDeckState, {
      type: 'prompt',
      sessionId: 's1',
      title: 'my-app',
      at: 10_000,
    })

    const alert = completionAlert(
      running,
      { type: 'stop', sessionId: 's1', title: 'my-app', at: 70_000 },
      { visible: false },
    )

    expect(alert).toEqual({ channel: 'push', title: 'my-app', elapsedMs: 60_000 })
  })

  it('stays silent for a sub-threshold turn — short chat turns must not ping', () => {
    const running = reduceDeck(initialDeckState, {
      type: 'prompt',
      sessionId: 's1',
      title: 'my-app',
      at: 10_000,
    })

    const alert = completionAlert(running, {
      type: 'stop',
      sessionId: 's1',
      title: 'my-app',
      at: 20_000,
    })

    expect(alert).toBeNull()
  })

  it('chooses the in-page channel while the deck is visible — flash and vibrate, not push', () => {
    const running = reduceDeck(initialDeckState, {
      type: 'prompt',
      sessionId: 's1',
      title: 'my-app',
      at: 10_000,
    })

    const alert = completionAlert(
      running,
      { type: 'stop', sessionId: 's1', title: 'my-app', at: 70_000 },
      { visible: true },
    )

    expect(alert).toEqual({ channel: 'in-page', title: 'my-app', elapsedMs: 60_000 })
  })

  it('honors a configured threshold in both directions', () => {
    const running = reduceDeck(initialDeckState, {
      type: 'prompt',
      sessionId: 's1',
      title: 'my-app',
      at: 0,
    })
    const stop = { type: 'stop', sessionId: 's1', title: 'my-app', at: 10_000 } as const

    expect(completionAlert(running, stop, { thresholdMs: 5_000 })).toMatchObject({
      elapsedMs: 10_000,
    })
    expect(completionAlert(running, stop, { thresholdMs: 15_000 })).toBeNull()
  })

  it('alerts a turn that ran exactly the threshold — "at least", not "longer than"', () => {
    const running = reduceDeck(initialDeckState, {
      type: 'prompt',
      sessionId: 's1',
      title: 'my-app',
      at: 0,
    })

    const alert = completionAlert(running, {
      type: 'stop',
      sessionId: 's1',
      title: 'my-app',
      at: 45_000,
    })

    expect(alert).toMatchObject({ channel: 'push' })
  })

  it('never re-alerts a redelivered stop — replay is at-least-once, alerts are exactly-once', () => {
    const running = reduceDeck(initialDeckState, {
      type: 'prompt',
      sessionId: 's1',
      title: 'my-app',
      at: 0,
    })
    const stop = { type: 'stop', sessionId: 's1', title: 'my-app', at: 60_000 } as const
    const done = reduceDeck(running, stop)

    expect(completionAlert(running, stop)).not.toBeNull()
    expect(completionAlert(done, { ...stop, at: 65_000 })).toBeNull()
  })

  it('stays silent on a stop with no observed prompt — an unknown duration cannot clear the threshold', () => {
    const alert = completionAlert(initialDeckState, {
      type: 'stop',
      sessionId: 's1',
      title: 'my-app',
      at: 60_000,
    })

    expect(alert).toBeNull()
  })

  it('never re-fires for a stale replayed stop — a reloaded deck must not re-ping old news', () => {
    // A fresh page load replays the whole ring buffer with no Last-Event-ID;
    // the clock must absorb the history, but only near-live stops are news.
    const running = reduceDeck(initialDeckState, {
      type: 'prompt',
      sessionId: 's1',
      title: 'my-app',
      at: 0,
    })
    const stop = { type: 'stop', sessionId: 's1', title: 'my-app', at: 60_000 } as const

    expect(completionAlert(running, stop, { now: 600_000 })).toBeNull()
    expect(completionAlert(running, stop, { now: 62_000 })).not.toBeNull()
  })

  it('ignores non-stop events', () => {
    const running = reduceDeck(initialDeckState, {
      type: 'prompt',
      sessionId: 's1',
      title: 'my-app',
      at: 0,
    })

    const alert = completionAlert(running, {
      type: 'prompt',
      sessionId: 's1',
      title: 'my-app',
      at: 60_000,
    })

    expect(alert).toBeNull()
  })
})

describe('local event time', () => {
  it('rebases a replayed event by its server-side age, immune to clock skew', () => {
    // Published at server time 10s, replayed at server time 70s: the event is
    // 60s old no matter what either clock reads absolutely.
    const receiptNow = 1_000_000
    expect(localEventTime({ at: 10_000, serverNow: 70_000 }, receiptNow)).toBe(940_000)
  })

  it('treats a live event as happening at receipt time — zero age, zero skew', () => {
    expect(localEventTime({ at: 80_000, serverNow: 80_000 }, 500_000)).toBe(500_000)
  })

  it('keeps the timer truthful end-to-end across a blip: replayed prompt, live view', () => {
    // Deck clock and server clock disagree wildly; the running elapsed time
    // must still reflect the real 60s that passed on the server.
    const receiptNow = 1_000_000
    const state = reduceDeck(initialDeckState, {
      type: 'prompt',
      sessionId: 's1',
      title: 'my-app',
      at: localEventTime({ at: 10_000, serverNow: 70_000 }, receiptNow),
    })

    expect(deckView(state, receiptNow)).toEqual({
      mode: 'running',
      title: 'my-app',
      elapsedMs: 60_000,
    })
  })

  it('falls back to receipt time when a frame carries no serverNow', () => {
    expect(localEventTime({ at: 10_000 }, 500_000)).toBe(500_000)
  })
})

describe('ambient pixel shift', () => {
  it('stays within a few pixels of center — the layout drifts, it never jumps', () => {
    for (let minute = 0; minute < 600; minute++) {
      const { x, y } = ambientShift(minute)
      expect(Math.abs(x)).toBeLessThanOrEqual(8)
      expect(Math.abs(y)).toBeLessThanOrEqual(8)
    }
  })

  it('moves every minute and revisits positions only on a cycle — no two adjacent minutes match', () => {
    const positions = new Set()
    for (let minute = 0; minute < 60; minute++) {
      const current = ambientShift(minute)
      const next = ambientShift(minute + 1)
      expect(current).not.toEqual(next)
      positions.add(`${current.x},${current.y}`)
    }
    // Burn-in protection needs real coverage, not a two-spot toggle.
    expect(positions.size).toBeGreaterThanOrEqual(4)
  })

  it('is a pure function of the minute index', () => {
    expect(ambientShift(17)).toEqual(ambientShift(17))
    expect(ambientShift(0)).toEqual(ambientShift(0))
  })
})

describe('clock formatting', () => {
  it('formats elapsed time as MM:SS under an hour and H:MM:SS beyond', () => {
    expect(formatElapsed(0)).toBe('00:00')
    expect(formatElapsed(61_000)).toBe('01:01')
    expect(formatElapsed(3_599_999)).toBe('59:59')
    expect(formatElapsed(3_600_000)).toBe('1:00:00')
    expect(formatElapsed(37_305_000)).toBe('10:21:45')
  })

  it('never renders negative digits when clocks disagree slightly', () => {
    expect(formatElapsed(-500)).toBe('00:00')
  })

  it('formats the idle clock as zero-padded 24h HH:MM', () => {
    expect(formatTimeOfDay(new Date(2026, 6, 3, 9, 5))).toBe('09:05')
    expect(formatTimeOfDay(new Date(2026, 6, 3, 23, 59))).toBe('23:59')
  })
})
