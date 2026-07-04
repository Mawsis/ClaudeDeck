import { describe, expect, it } from 'vitest'
import { createPauseState } from '../src/gateway/pause-state.ts'

describe('pause state', () => {
  it('starts intercepting — D5 always intercepts while a deck is connected', () => {
    const state = createPauseState()

    expect(state.isPaused()).toBe(false)
  })

  it('flips to passthrough on the first tap and back on the second — one control, no arming ritual', () => {
    const state = createPauseState()

    expect(state.toggle()).toBe(true)
    expect(state.isPaused()).toBe(true)

    expect(state.toggle()).toBe(false)
    expect(state.isPaused()).toBe(false)
  })
})
