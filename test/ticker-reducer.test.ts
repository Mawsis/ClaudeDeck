import { describe, expect, it } from 'vitest'
import { initialTicker, reduceTicker } from '../src/pwa/deck-reducer.js'

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

describe('ticker reducer', () => {
  it('starts empty and appends a tool event as the newest row', () => {
    const ticker = reduceTicker(initialTicker, toolEvent(1))

    expect(initialTicker).toEqual([])
    expect(ticker).toEqual([
      {
        key: 'boot-a:1',
        tool: 'Bash',
        detail: 'npm install hono',
        risk: 'highlighted',
        at: 10_001,
      },
    ])
  })

  it('ignores lifecycle events — only tool calls are audit rows', () => {
    const ticker = reduceTicker(initialTicker, {
      type: 'prompt',
      id: 1,
      sessionId: 's1',
      title: 'my-app',
      at: 10_000,
    })

    expect(ticker).toBe(initialTicker)
  })

  it('drops the oldest row beyond capacity — the strip never grows unbounded', () => {
    let ticker = initialTicker
    for (let id = 1; id <= 30; id += 1) {
      ticker = reduceTicker(ticker, toolEvent(id))
    }

    expect(ticker.length).toBeLessThanOrEqual(20)
    expect(ticker[0]!.key).toBe('boot-a:30')
    expect(ticker.at(-1)!.key).toBe(`boot-a:${30 - ticker.length + 1}`)
  })

  it('ignores a redelivered event — reconnect replay must not duplicate audit rows', () => {
    const once = reduceTicker(initialTicker, toolEvent(7))
    const twice = reduceTicker(once, toolEvent(7))

    expect(twice).toBe(once)
  })

  it('keeps a colliding id from a restarted gateway — a new boot means a new event, not a duplicate', () => {
    // A restarted gateway counts ids from 1 again; a deck that stayed open
    // still holds rows with those ids from the previous process.
    const beforeRestart = reduceTicker(initialTicker, toolEvent(1))
    const afterRestart = reduceTicker(beforeRestart, toolEvent(1, { bootId: 'boot-b', detail: 'git push' }))

    expect(afterRestart).toHaveLength(2)
    expect(afterRestart[0]).toMatchObject({ key: 'boot-b:1', detail: 'git push' })
    expect(afterRestart[1]).toMatchObject({ key: 'boot-a:1', detail: 'npm install hono' })
  })
})
