import { describe, expect, it } from 'vitest'
import { brandAsset, clawdPose, clawdSprite } from '../src/pwa/deck-reducer.js'

describe('clawd pose', () => {
  it('acts out the session modes: sleeping when idle, typing while running, waving on done', () => {
    expect(clawdPose({ mode: 'idle' })).toBe('sleeping')
    expect(clawdPose({ mode: 'running', title: 'my-app', elapsedMs: 1_000 })).toBe('typing')
    expect(clawdPose({ mode: 'done', title: 'my-app', elapsedMs: 60_000 })).toBe('waving')
  })

  it('overlays paused onto any session mode — the purple state needs its own pose', () => {
    expect(clawdPose({ mode: 'idle', paused: true })).toBe('paused')
    expect(clawdPose({ mode: 'running', title: 'my-app', elapsedMs: 1_000, paused: true })).toBe(
      'paused',
    )
    expect(clawdPose({ mode: 'done', title: 'my-app', elapsedMs: 60_000, paused: true })).toBe(
      'paused',
    )
  })

  it('goes offline with the deck — a down stream owns the pose outright, like the accent', () => {
    expect(clawdPose({ mode: 'offline' })).toBe('offline')
  })

  it('is alarmed while a prompt waits — the takeover state gets its own pose', () => {
    expect(clawdPose({ mode: 'running', title: 'my-app', elapsedMs: 1_000 }, true)).toBe('alarmed')
    // Even paused: a card can only be up if it arrived before the pause, and
    // an unanswered prompt is still the more urgent truth.
    expect(clawdPose({ mode: 'idle', paused: true }, true)).toBe('alarmed')
  })

  it('never shows alarmed on a dead stream — a card the deck cannot answer must not beckon', () => {
    expect(clawdPose({ mode: 'offline' }, true)).toBe('offline')
  })

  it('gives every deck state a distinct pose — no two ambiguous at a glance', () => {
    const poses = [
      clawdPose({ mode: 'idle' }),
      clawdPose({ mode: 'running', title: 't', elapsedMs: 0 }),
      clawdPose({ mode: 'done', title: 't', elapsedMs: 0 }),
      clawdPose({ mode: 'idle', paused: true }),
      clawdPose({ mode: 'offline' }),
      clawdPose({ mode: 'idle' }, true),
    ]

    expect(new Set(poses).size).toBe(poses.length)
  })
})

describe('brand assets', () => {
  it('resolves every asset through one swappable directory — a rebrand is an asset swap, not a refactor', () => {
    expect(brandAsset('icon.svg')).toBe('/brand/icon.svg')
    expect(clawdSprite('typing')).toBe('/brand/clawd-typing.svg')
    expect(clawdSprite('sleeping')).toBe('/brand/clawd-sleeping.svg')
  })
})
