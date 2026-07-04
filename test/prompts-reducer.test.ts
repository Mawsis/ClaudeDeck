import { describe, expect, it } from 'vitest'
import { allowHoldMs, initialPrompts, reducePrompts } from '../src/pwa/deck-reducer.js'

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
      { promptId: 'p-1', title: 'my-app', tool: 'Bash', detail: 'rm -rf build', risk: 'routine' },
    ])
  })

  it('carries D15 risk onto the card — the Allow hold scales with it', () => {
    const prompts = reducePrompts(initialPrompts, permissionEvent('p-1', { risk: 'high' }))

    expect(prompts[0]).toMatchObject({ promptId: 'p-1', risk: 'high' })
  })

  it('normalizes an absent or unknown risk to routine — external JSON never picks the hold length', () => {
    const absent = reducePrompts(initialPrompts, permissionEvent('p-1'))
    const junk = reducePrompts(initialPrompts, permissionEvent('p-2', { risk: 'extreme' }))

    expect(absent[0]!.risk).toBe('routine')
    expect(junk[0]!.risk).toBe('routine')
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

  it('queues FIFO — the deck answers prompts in arrival order', () => {
    let prompts = initialPrompts
    for (const id of ['p-1', 'p-2', 'p-3']) {
      prompts = reducePrompts(prompts, permissionEvent(id))
    }

    expect(prompts.map((prompt) => prompt.promptId)).toEqual(['p-1', 'p-2', 'p-3'])
  })
})
