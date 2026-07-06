import { describe, expect, it } from 'vitest'
import {
  BUBBLE_LINE_MAX,
  bubbleLine,
  bubbleVerbLine,
  bubbleVisible,
  initialBubble,
  reduceBubble,
  SPINNER_VERBS,
  spinnerVerb,
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
  it('starts empty and fills with the latest tool command, carrying its risk tier, category, and project', () => {
    const bubble = reduceBubble(initialBubble, toolEvent(1))

    expect(initialBubble).toEqual({
      phase: 'empty',
      key: '',
      tool: '',
      detail: '',
      category: 'routine',
      risk: 'routine',
      project: '',
    })
    expect(bubble).toEqual({
      phase: 'command',
      key: 'boot-a:1',
      tool: 'Bash',
      detail: 'npm install hono',
      category: 'package-install',
      risk: 'highlighted',
      project: 'my-app',
    })
  })

  it('preserves all three risk tiers end-to-end — high, highlighted, and routine each survive the reducer distinctly', () => {
    const high = reduceBubble(
      initialBubble,
      toolEvent(1, { detail: 'rm -rf build/', category: 'destructive-delete', risk: 'high' }),
    )
    const highlighted = reduceBubble(high, toolEvent(2))
    const routine = reduceBubble(
      highlighted,
      toolEvent(3, { detail: 'ls -la', category: 'routine', risk: 'routine' }),
    )

    expect(high.risk).toBe('high')
    expect(highlighted.risk).toBe('highlighted')
    expect(routine.risk).toBe('routine')
  })

  it('degrades an unknown or missing risk tier to routine — external JSON is never trusted to be a valid tier', () => {
    const missing = reduceBubble(initialBubble, toolEvent(1, { risk: undefined }))
    const junk = reduceBubble(initialBubble, toolEvent(2, { risk: 'catastrophic' }))

    expect(missing.risk).toBe('routine')
    expect(junk.risk).toBe('routine')
  })

  it('holds the latest command — a newer tool event overwrites the held line', () => {
    const first = reduceBubble(initialBubble, toolEvent(1))
    const second = reduceBubble(
      first,
      toolEvent(2, { tool: 'Edit', detail: 'src/app.ts', category: 'edit', risk: 'routine' }),
    )

    expect(second).toMatchObject({ key: 'boot-a:2', tool: 'Edit', detail: 'src/app.ts' })
  })

  it('holds the command across mid-turn frames — a continuation prompt, mode, and handshake never disturb the held line', () => {
    const held = reduceBubble(initialBubble, toolEvent(1))

    // A prompt arriving after a command is a mid-turn continuation; mode and
    // handshake carry no command — none of them replaces the running command.
    for (const type of ['prompt', 'mode', 'handshake']) {
      expect(reduceBubble(held, { type, id: 2, bootId: 'boot-a', title: 'other' }), type).toBe(held)
    }
  })

  it('deduplicates a replayed tool event by (bootId, id) — a reconnect blip must not restack the bubble', () => {
    const once = reduceBubble(initialBubble, toolEvent(1))

    expect(reduceBubble(once, toolEvent(1))).toBe(once)
  })

  it('treats a reused id from a restarted gateway as a new command — a fresh bootId is not a duplicate', () => {
    const before = reduceBubble(initialBubble, toolEvent(1))
    const after = reduceBubble(before, toolEvent(1, { bootId: 'boot-b', detail: 'ls -la' }))

    expect(after).toMatchObject({ key: 'boot-b:1', tool: 'Bash', detail: 'ls -la' })
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

    expect(bubble).toMatchObject({ key: 'boot-a:5', tool: 'Bash', detail: 'cmd-5' })
  })
})

const bubbleOf = (detail: string, tool = 'Bash', category = 'routine') => ({
  phase: 'command' as const,
  key: 'boot-a:1',
  tool,
  detail,
  category,
  risk: 'routine' as const,
  project: 'my-app',
})

describe('bubbleLine', () => {
  it('shows a routine Bash command as its raw head, untouched when it fits', () => {
    expect(bubbleLine(bubbleOf('npm install hono'))).toBe('npm install hono')
  })

  it('shows an edit tool line as the relative path the gateway extracted, untouched when it fits', () => {
    expect(bubbleLine(bubbleOf('src/gateway/app.ts', 'Edit', 'edit'))).toBe('src/gateway/app.ts')
  })

  it('prefixes a classified high-impact Bash command with its category label and a middle dot', () => {
    // a3 hybrid: scannable label, then the real command tail with the labeled
    // verb stripped so it does not echo — `git push · origin main…`.
    expect(bubbleLine(bubbleOf('git push origin main', 'Bash', 'git-push'))).toBe(
      'git push · origin main',
    )
  })

  it('labels each classifier category with its fixed copy and strips the leading verb from the tail', () => {
    const cases: ReadonlyArray<readonly [string, string, string]> = [
      ['git-push', 'git push origin main --set-upstream', 'git push · origin main --set-upstream'],
      ['force-push', 'git push --force origin main', '⚠ git push --force · origin main'],
      ['package-install', 'npm install hono', 'installing · hono'],
      ['migration', 'prisma migrate deploy', '⚠ db migration · prisma migrate deploy'],
      ['deploy', 'kubectl apply -f k8s/', '⚠ deploying · kubectl apply -f k8s/'],
      ['docker', 'docker compose up -d', 'docker · compose up -d'],
      ['destructive-delete', 'rm -rf build/ dist/', '⚠ rm -rf · build/ dist/'],
    ]
    for (const [category, detail, expected] of cases) {
      expect(bubbleLine(bubbleOf(detail, 'Bash', category)), category).toBe(expected)
    }
  })

  it('falls through to the raw head for the routine category and the edit tools — no label, no dot', () => {
    expect(bubbleLine(bubbleOf('ls -la', 'Bash', 'routine'))).toBe('ls -la')
    expect(bubbleLine(bubbleOf('src/app.ts', 'Edit', 'edit'))).toBe('src/app.ts')
  })

  it('shows the label alone when stripping the verb leaves an empty tail — a bare `docker` is not `docker · `', () => {
    expect(bubbleLine(bubbleOf('docker', 'Bash', 'docker'))).toBe('docker')
  })

  it('keeps the full command as the tail when the labeled verb is buried in a compound command', () => {
    // The classifier matches anywhere (`cd app && npm install`), so there is no
    // leading verb to strip; the whole command is the honest tail.
    expect(bubbleLine(bubbleOf('cd app && npm install', 'Bash', 'package-install'))).toBe(
      'installing · cd app && npm install',
    )
  })

  it('truncates a classified line on the composed label+tail, not the raw command alone', () => {
    const detail = `git push origin ${'b'.repeat(BUBBLE_LINE_MAX)}`
    const line = bubbleLine(bubbleOf(detail, 'Bash', 'git-push'))

    expect(line.startsWith('git push · origin ')).toBe(true)
    expect(line.endsWith('…')).toBe(true)
    expect([...line]).toHaveLength(BUBBLE_LINE_MAX + 1)
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

describe('spinnerVerb', () => {
  it('is deterministic — the same seed always picks the same verb, no Math.random anywhere', () => {
    // The reducer layer injects the seed exactly as it injects Date.now()
    // elsewhere; a pure picker means the same tick renders the same word on
    // every device, and a test can pin an exact value.
    expect(spinnerVerb(0)).toBe(spinnerVerb(0))
    expect(spinnerVerb(42)).toBe(spinnerVerb(42))
  })

  it('walks the full published list — every verb from Accomplishing to Zesting is reachable as the seed advances', () => {
    // The seed is a plain modulo index, so sweeping one full period must visit
    // every word exactly once — proof the picker draws on the whole list, not a
    // truncated head.
    const reached = new Set(SPINNER_VERBS.map((_, seed) => spinnerVerb(seed)))

    expect(SPINNER_VERBS.length).toBeGreaterThanOrEqual(180)
    expect(SPINNER_VERBS[0]).toBe('Accomplishing')
    expect(SPINNER_VERBS.at(-1)).toBe('Zesting')
    expect(reached.size).toBe(SPINNER_VERBS.length)
  })

  it('wraps past the end of the list — the seed cycles forever without ever indexing off the array', () => {
    // The render tick only grows; the picker must fold it back onto the list so
    // a long-running session keeps cycling instead of falling off into
    // undefined.
    expect(spinnerVerb(SPINNER_VERBS.length)).toBe(spinnerVerb(0))
    expect(spinnerVerb(SPINNER_VERBS.length * 3 + 5)).toBe(spinnerVerb(5))
  })

  it('falls back to the first verb for a non-finite seed rather than reading undefined off the array', () => {
    // A clock read gone NaN/Infinity must not blank the bubble mid-think.
    expect(spinnerVerb(Number.NaN)).toBe(SPINNER_VERBS[0])
    expect(spinnerVerb(Number.POSITIVE_INFINITY)).toBe(SPINNER_VERBS[0])
  })
})

const promptEvent = (overrides: Record<string, unknown> = {}) => ({
  type: 'prompt',
  id: 1,
  bootId: 'boot-a',
  sessionId: 's1',
  title: 'my-app',
  at: 10_000,
  ...overrides,
})

describe('reduceBubble verb window', () => {
  it('enters the verb window on prompt-submit — the bubble holds a thinking phase tagged with the project, no command yet', () => {
    const thinking = reduceBubble(initialBubble, promptEvent())

    expect(thinking.phase).toBe('verb')
    expect(thinking.project).toBe('my-app')
    expect(thinking.detail).toBe('')
  })

  it('hands off from verb to command the instant the first tool lands — the verb window ends on the first command', () => {
    const thinking = reduceBubble(initialBubble, promptEvent())
    const running = reduceBubble(thinking, toolEvent(2, { detail: 'npm install hono' }))

    expect(running.phase).toBe('command')
    expect(running.detail).toBe('npm install hono')
  })

  it('never shows a verb between commands — a mid-turn prompt after a command holds the running command, not a fresh think', () => {
    // A slow command in flight is indistinguishable from a thinking gap, and a
    // decorative verb there would replace a truthfully running command. A prompt
    // that arrives once a command is held is a continuation, so the bubble stays
    // on the command.
    let bubble = reduceBubble(initialBubble, promptEvent())
    bubble = reduceBubble(bubble, toolEvent(2, { detail: 'first cmd' }))
    bubble = reduceBubble(bubble, promptEvent({ id: 3, title: 'my-app' }))

    expect(bubble.phase).toBe('command')
    expect(bubble.detail).toBe('first cmd')
  })

  it('swaps one command for the next within a turn without ever passing through a verb', () => {
    let bubble = reduceBubble(initialBubble, promptEvent())
    bubble = reduceBubble(bubble, toolEvent(2, { detail: 'first cmd' }))
    bubble = reduceBubble(bubble, toolEvent(3, { detail: 'second cmd' }))

    expect(bubble.phase).toBe('command')
    expect(bubble.detail).toBe('second cmd')
  })

  it('leaves the bubble empty on a handshake — the install ping fires with no session and must never render as a command or a verb', () => {
    const afterHandshake = reduceBubble(initialBubble, {
      type: 'handshake',
      id: 1,
      bootId: 'boot-a',
      title: 'my-app',
    })

    expect(afterHandshake).toBe(initialBubble)
    expect(afterHandshake.phase).toBe('empty')
  })

  it('closes the turn on stop so the next prompt can reopen the verb window — a verb, then a command, then rest, then a verb again', () => {
    let bubble = reduceBubble(initialBubble, promptEvent())
    bubble = reduceBubble(bubble, toolEvent(2, { detail: 'first cmd' }))
    const afterStop = reduceBubble(bubble, { type: 'stop', id: 3, bootId: 'boot-a' })
    const nextTurn = reduceBubble(afterStop, promptEvent({ id: 4, title: 'my-app' }))

    expect(afterStop.phase).toBe('empty')
    expect(nextTurn.phase).toBe('verb')
  })
})

describe('bubbleVerbLine', () => {
  it('renders the ellipsis-suffixed thinking verb for a tick — the line the bubble shows during the verb window', () => {
    // The projection injects the render tick as the seed; the verb line is the
    // cycling word with the CLI-style trailing ellipsis so it reads as an
    // in-progress thought, not a finished label.
    expect(bubbleVerbLine(0)).toBe(`${spinnerVerb(0)}…`)
    expect(bubbleVerbLine(42)).toBe(`${spinnerVerb(42)}…`)
  })

  it('cycles as the tick advances — a later tick can show a different verb, driving the ~1.5s TUI cadence from the caller', () => {
    // The word only ever changes when the injected tick changes, so the caller
    // owns the cadence (Math.floor(now / 1500)); across a full period the line
    // visits more than one distinct verb.
    const lines = new Set(SPINNER_VERBS.map((_, tick) => bubbleVerbLine(tick)))

    expect(lines.size).toBe(SPINNER_VERBS.length)
  })
})
