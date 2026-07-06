import { describe, expect, it } from 'vitest'
import { bubbleVisible, titleVisible } from '../src/pwa/deck-reducer.js'

// Every pose the mascot can hold that is not the working one: done, idle,
// permission card, paused, disconnected. None of them speaks.
const NON_TYPING_POSES = ['waving', 'sleeping', 'alarmed', 'paused', 'offline'] as const

describe('bubble visibility', () => {
  it('shows the bubble exactly while Clawd is typing — a running session speaks', () => {
    expect(bubbleVisible('typing')).toBe(true)
  })

  it('clears the bubble the instant the pose leaves typing — presence never disagrees with the mascot', () => {
    for (const pose of NON_TYPING_POSES) {
      expect(bubbleVisible(pose), pose).toBe(false)
    }
  })
})

describe('title visibility', () => {
  it('hides the SLOPDECK title while the bubble speaks — the live line owns the top of the deck', () => {
    expect(titleVisible('typing')).toBe(false)
  })

  it('returns the title when the deck is at rest — a resting deck reads as a clean desk clock', () => {
    for (const pose of NON_TYPING_POSES) {
      expect(titleVisible(pose), pose).toBe(true)
    }
  })
})
