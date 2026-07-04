import { describe, expect, it } from 'vitest'
import {
  CRT_CHOREO_MS,
  deckSignature,
  deckTransition,
  pulseColon,
  STRIPE_WIPE_MS,
} from '../src/pwa/deck-reducer.js'

describe('deck transition choreography (D17)', () => {
  it('fires the full CRT choreography on exactly one event — prompt arrival', () => {
    const before = deckSignature({ mode: 'running', title: 't', elapsedMs: 1_000 }, false)
    const after = deckSignature({ mode: 'running', title: 't', elapsedMs: 1_000 }, true)

    expect(deckTransition(before, after)).toBe('crt')
  })

  it('gives every other state change one stripe-wipe — mode flips, pause, offline, card dismissal', () => {
    const idle = deckSignature({ mode: 'idle' }, false)
    const running = deckSignature({ mode: 'running', title: 't', elapsedMs: 0 }, false)
    const done = deckSignature({ mode: 'done', title: 't', elapsedMs: 60_000 }, false)
    const offline = deckSignature({ mode: 'offline' }, false)
    const paused = deckSignature({ mode: 'idle', paused: true }, false)
    const cardUp = deckSignature({ mode: 'running', title: 't', elapsedMs: 0 }, true)

    expect(deckTransition(idle, running)).toBe('wipe')
    expect(deckTransition(running, done)).toBe('wipe')
    expect(deckTransition(running, offline)).toBe('wipe')
    expect(deckTransition(idle, paused)).toBe('wipe')
    // A dismissed takeover is a state change too — but never a second CRT.
    expect(deckTransition(cardUp, running)).toBe('wipe')
  })

  it('fires nothing while the state holds — a ticking clock is not a transition', () => {
    const before = deckSignature({ mode: 'running', title: 't', elapsedMs: 1_000 }, false)
    const after = deckSignature({ mode: 'running', title: 't', elapsedMs: 2_000 }, false)

    expect(deckTransition(before, after)).toBeNull()
  })

  it('spends within the budget: every transition completes under 600ms, the wipe shorter than the CRT', () => {
    expect(STRIPE_WIPE_MS).toBeLessThan(600)
    expect(CRT_CHOREO_MS).toBeLessThan(600)
    // The full choreography is the ceremony; the everyday wipe must read
    // as the lesser event.
    expect(STRIPE_WIPE_MS).toBeLessThan(CRT_CHOREO_MS)
  })
})

describe('idle colon pulse (D17)', () => {
  it('pulses at 1Hz: visible one half-second, hidden the next', () => {
    expect(pulseColon('14:05', 0)).toBe('14:05')
    expect(pulseColon('14:05', 499)).toBe('14:05')
    expect(pulseColon('14:05', 500)).toBe('14 05')
    expect(pulseColon('14:05', 999)).toBe('14 05')
    expect(pulseColon('14:05', 1_000)).toBe('14:05')
  })

  it('never shifts the digits — the hidden colon keeps its column', () => {
    expect(pulseColon('14:05', 500)).toHaveLength('14:05'.length)
  })
})
