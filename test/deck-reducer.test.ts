import { describe, expect, it } from 'vitest'
import {
  ambientShift,
  deckView,
  formatElapsed,
  formatTimeOfDay,
  initialDeckState,
  localEventTime,
  reduceDeck,
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
