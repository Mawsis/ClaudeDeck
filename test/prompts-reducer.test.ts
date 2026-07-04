import { describe, expect, it } from 'vitest'
import { allowHoldMs, initialPrompts, queueBadge, reducePrompts } from '../src/pwa/deck-reducer.js'

const permissionEvent = (promptId: string, overrides: Record<string, unknown> = {}) => ({
  type: 'permission',
  id: 10,
  sessionId: 's1',
  title: 'my-app',
  promptId,
  tool: 'Bash',
  detail: 'rm -rf build',
  at: 10_000,
  ...overrides,
})

describe('prompts reducer', () => {
  it('starts empty and holds an arriving permission prompt as a renderable card', () => {
    const prompts = reducePrompts(initialPrompts, permissionEvent('p-1'))

    expect(initialPrompts).toEqual([])
    expect(prompts).toEqual([
      {
        kind: 'permission',
        promptId: 'p-1',
        sessionId: 's1',
        title: 'my-app',
        tool: 'Bash',
        detail: 'rm -rf build',
        risk: 'routine',
      },
    ])
  })

  it('carries D15 risk onto the card — the Allow hold scales with it', () => {
    const prompts = reducePrompts(initialPrompts, permissionEvent('p-1', { risk: 'high' }))

    expect(prompts[0]).toMatchObject({ promptId: 'p-1', risk: 'high' })
  })

  it('normalizes an absent or unknown risk to routine — external JSON never picks the hold length', () => {
    const absent = reducePrompts(initialPrompts, permissionEvent('p-1'))
    const junk = reducePrompts(initialPrompts, permissionEvent('p-2', { risk: 'extreme' }))

    expect(absent[0]).toMatchObject({ risk: 'routine' })
    expect(junk[0]).toMatchObject({ risk: 'routine' })
  })

  it('drops the settled card on permission-resolved, keeping the rest of the queue', () => {
    let prompts = reducePrompts(initialPrompts, permissionEvent('p-1'))
    prompts = reducePrompts(prompts, permissionEvent('p-2', { detail: 'git push --force' }))

    const afterResolve = reducePrompts(prompts, {
      type: 'permission-resolved',
      promptId: 'p-1',
      outcome: 'allow',
    })

    expect(afterResolve.map((prompt) => prompt.promptId)).toEqual(['p-2'])
  })

  it('ignores a redelivered prompt — reconnect replay must not duplicate a card', () => {
    const once = reducePrompts(initialPrompts, permissionEvent('p-1'))
    const twice = reducePrompts(once, permissionEvent('p-1'))

    expect(twice).toBe(once)
  })

  it('ignores a resolution for a prompt it never held — replayed history of settled pairs', () => {
    const prompts = reducePrompts(initialPrompts, permissionEvent('p-2'))

    const after = reducePrompts(prompts, {
      type: 'permission-resolved',
      promptId: 'p-gone',
      outcome: 'ask',
    })

    expect(after).toEqual(prompts)
  })

  // D15: ~500ms is enough to stop a brush; a high-risk command needs a hold
  // long enough that completing it can only be deliberate.
  it('scales the Allow hold with risk — visibly longer for high-risk commands', () => {
    expect(allowHoldMs('routine')).toBe(500)
    expect(allowHoldMs('high')).toBe(1500)
    expect(allowHoldMs('high')).toBeGreaterThanOrEqual(2 * allowHoldMs('routine'))
  })

  it('labels each card with its session — two sessions in one project must be tellable apart', () => {
    let prompts = reducePrompts(initialPrompts, permissionEvent('p-1', { sessionId: 's1' }))
    prompts = reducePrompts(prompts, permissionEvent('p-2', { sessionId: 's2' }))

    expect(prompts.map((prompt) => prompt.sessionId)).toEqual(['s1', 's2'])
  })

  it('normalizes an absent sessionId to an empty string — external JSON never renders as "undefined"', () => {
    const prompts = reducePrompts(initialPrompts, permissionEvent('p-1', { sessionId: undefined }))

    expect(prompts[0]!.sessionId).toBe('')
  })

  it('queues FIFO — the deck answers prompts in arrival order', () => {
    let prompts = initialPrompts
    for (const id of ['p-1', 'p-2', 'p-3']) {
      prompts = reducePrompts(prompts, permissionEvent(id))
    }

    expect(prompts.map((prompt) => prompt.promptId)).toEqual(['p-1', 'p-2', 'p-3'])
  })

  it('holds an arriving question as a card with tappable options, in the same FIFO queue', () => {
    let prompts = reducePrompts(initialPrompts, permissionEvent('p-1'))
    prompts = reducePrompts(prompts, {
      type: 'question',
      id: 11,
      sessionId: 's1',
      title: 'my-app',
      promptId: 'q-1',
      question: 'Which auth method?',
      options: ['OAuth', 'API key'],
      at: 11_000,
    })

    expect(prompts.map((prompt) => prompt.promptId)).toEqual(['p-1', 'q-1'])
    expect(prompts[0]!.kind).toBe('permission')
    expect(prompts[1]).toMatchObject({
      kind: 'question',
      question: 'Which auth method?',
      options: ['OAuth', 'API key'],
    })
  })

  it('drops the settled question card on question-resolved and ignores duplicates', () => {
    const question = {
      type: 'question',
      id: 11,
      sessionId: 's1',
      title: 'my-app',
      promptId: 'q-1',
      question: 'Which auth method?',
      options: ['OAuth', 'API key'],
      at: 11_000,
    }
    const once = reducePrompts(initialPrompts, question)
    // Reconnect replay is at-least-once; a redelivered question is the same card.
    expect(reducePrompts(once, question)).toBe(once)

    const after = reducePrompts(once, { type: 'question-resolved', promptId: 'q-1', outcome: 'answered' })
    expect(after).toEqual([])
  })

  it('normalizes junk option entries to strings — external JSON never renders as objects', () => {
    const prompts = reducePrompts(initialPrompts, {
      type: 'question',
      promptId: 'q-1',
      question: 'Pick one',
      options: ['OK', 42, null],
    })

    expect(prompts[0]).toMatchObject({ options: ['OK', '42', ''] })
  })

  // The takeover already IS the first prompt; the badge answers "what's
  // behind it?" — so it counts the rest and vanishes when nothing waits.
  it('shows queue depth behind the visible card and clears as the queue drains', () => {
    let prompts = initialPrompts
    expect(queueBadge(prompts)).toBe('')

    prompts = reducePrompts(prompts, permissionEvent('p-1'))
    expect(queueBadge(prompts)).toBe('')

    prompts = reducePrompts(prompts, permissionEvent('p-2'))
    prompts = reducePrompts(prompts, permissionEvent('p-3'))
    expect(queueBadge(prompts)).toBe('+2 QUEUED')

    prompts = reducePrompts(prompts, {
      type: 'permission-resolved',
      promptId: 'p-1',
      outcome: 'allow',
    })
    expect(queueBadge(prompts)).toBe('+1 QUEUED')

    prompts = reducePrompts(prompts, {
      type: 'permission-resolved',
      promptId: 'p-2',
      outcome: 'ask',
    })
    expect(queueBadge(prompts)).toBe('')
  })
})
