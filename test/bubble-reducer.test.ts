import { describe, expect, it } from 'vitest'
import {
  BUBBLE_LINE_MAX,
  bubbleLine,
  bubbleVisible,
  initialBubble,
  reduceBubble,
  titleVisible,
} from '../src/pwa/deck-reducer.js'

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

const toolEvent = (id: number, overrides: Record<string, unknown> = {}) => ({
  type: 'tool',
  id,
  bootId: 'boot-a',
  sessionId: 's1',
  title: 'my-app',
  tool: 'Bash',
  detail: 'npm install hono',
  category: 'package-install',
  risk: 'highlighted',
  at: 10_000 + id,
  ...overrides,
})

describe('reduceBubble', () => {
  it('starts empty and fills with the latest tool command', () => {
    const bubble = reduceBubble(initialBubble, toolEvent(1))

    expect(initialBubble).toEqual({ key: '', tool: '', detail: '' })
    expect(bubble).toEqual({ key: 'boot-a:1', tool: 'Bash', detail: 'npm install hono' })
  })

  it('holds the latest command — a newer tool event overwrites the held line', () => {
    const first = reduceBubble(initialBubble, toolEvent(1))
    const second = reduceBubble(first, toolEvent(2, { tool: 'Edit', detail: 'src/app.ts' }))

    expect(second).toEqual({ key: 'boot-a:2', tool: 'Edit', detail: 'src/app.ts' })
  })

  it('holds the command across lifecycle frames — only the pose clears the bubble, never a stop', () => {
    const held = reduceBubble(initialBubble, toolEvent(1))

    for (const type of ['prompt', 'stop', 'mode', 'handshake']) {
      expect(reduceBubble(held, { type, id: 2, bootId: 'boot-a' }), type).toBe(held)
    }
  })

  it('deduplicates a replayed tool event by (bootId, id) — a reconnect blip must not restack the bubble', () => {
    const once = reduceBubble(initialBubble, toolEvent(1))

    expect(reduceBubble(once, toolEvent(1))).toBe(once)
  })

  it('treats a reused id from a restarted gateway as a new command — a fresh bootId is not a duplicate', () => {
    const before = reduceBubble(initialBubble, toolEvent(1))
    const after = reduceBubble(before, toolEvent(1, { bootId: 'boot-b', detail: 'ls -la' }))

    expect(after).toEqual({ key: 'boot-b:1', tool: 'Bash', detail: 'ls -la' })
  })

  it('reflects the true latest command after a reconnect replays the whole buffer in id order', () => {
    // The gateway's ring buffer replays in ascending id order (event-log.ts),
    // so the last frame reduced is the highest id — the genuine latest command.
    // A reconnect that redelivers the whole history therefore lands on the same
    // line a live stream would, with the earlier frames deduped or overwritten.
    let bubble = initialBubble
    for (const id of [3, 4, 5]) {
      bubble = reduceBubble(bubble, toolEvent(id, { detail: `cmd-${id}` }))
    }
    // Reconnect: the whole buffer replays from the top, in the same order.
    for (const id of [3, 4, 5]) {
      bubble = reduceBubble(bubble, toolEvent(id, { detail: `cmd-${id}` }))
    }

    expect(bubble).toEqual({ key: 'boot-a:5', tool: 'Bash', detail: 'cmd-5' })
  })
})

const bubbleOf = (detail: string, tool = 'Bash') => ({ key: 'boot-a:1', tool, detail })

describe('bubbleLine', () => {
  it('shows a routine Bash command as its raw head, untouched when it fits', () => {
    expect(bubbleLine(bubbleOf('npm install hono'))).toBe('npm install hono')
  })

  it('shows an edit tool line as the relative path the gateway extracted, untouched when it fits', () => {
    expect(bubbleLine(bubbleOf('src/gateway/app.ts', 'Edit'))).toBe('src/gateway/app.ts')
  })

  it('truncates an over-long line with a trailing ellipsis on one line', () => {
    const long = 'a'.repeat(BUBBLE_LINE_MAX + 40)
    const line = bubbleLine(bubbleOf(long))

    expect(line.endsWith('…')).toBe(true)
    expect([...line]).toHaveLength(BUBBLE_LINE_MAX + 1) // BUBBLE_LINE_MAX chars + the ellipsis
    expect(line.includes('\n')).toBe(false)
  })

  it('leaves a line at exactly the budget untouched — the ellipsis only marks a real cut', () => {
    const exact = 'b'.repeat(BUBBLE_LINE_MAX)

    expect(bubbleLine(bubbleOf(exact))).toBe(exact)
  })

  it('cuts on a code-point boundary — an over-long line of astral glyphs never splits a surrogate pair', () => {
    // Each 🦞 is one code point but two UTF-16 units; a naive slice would land
    // inside a pair and leave a lone surrogate (U+D800–U+DFFF).
    const line = bubbleLine(bubbleOf('🦞'.repeat(BUBBLE_LINE_MAX + 20)))
    const points = [...line]

    expect(points).toHaveLength(BUBBLE_LINE_MAX + 1) // budget of glyphs + the ellipsis
    expect(points.at(-1)).toBe('…')
    for (const glyph of points.slice(0, -1)) {
      expect(glyph).toBe('🦞') // every kept glyph is whole — no half a pair
    }
    // Belt and braces: no unpaired surrogate anywhere in the string.
    expect(/[\uD800-\uDFFF]/.test(line.replace(/[\uD800-\uDBFF][\uDC00-\uDFFF]/g, ''))).toBe(false)
  })
})
