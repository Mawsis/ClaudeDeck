import { describe, expect, it } from 'vitest'
import { createEventLog } from '../src/gateway/event-log.ts'

describe('event log', () => {
  it('assigns strictly increasing monotonic ids starting at 1', () => {
    const log = createEventLog()

    const first = log.publish({ type: 'stop', sessionId: 's1', title: 'my-app', cwd: '/home/u/my-app' })
    const second = log.publish({ type: 'stop', sessionId: 's1', title: 'my-app', cwd: '/home/u/my-app' })
    const third = log.publish({ type: 'stop', sessionId: 's2', title: 'other', cwd: '/home/u/other' })

    expect(first.id).toBe(1)
    expect(second.id).toBe(2)
    expect(third.id).toBe(3)
  })

  it('delivers published events to subscribers', () => {
    const log = createEventLog()
    const received: unknown[] = []

    log.subscribe((event) => received.push(event))
    const published = log.publish({ type: 'stop', sessionId: 's1', title: 'my-app', cwd: '/home/u/my-app' })

    expect(received).toEqual([published])
  })

  it('stops delivering after unsubscribe', () => {
    const log = createEventLog()
    const received: unknown[] = []

    const unsubscribe = log.subscribe((event) => received.push(event))
    log.publish({ type: 'stop', sessionId: 's1', title: 'a', cwd: '/a' })
    unsubscribe()
    log.publish({ type: 'stop', sessionId: 's1', title: 'b', cwd: '/b' })

    expect(received).toHaveLength(1)
  })

  it('keeps only the newest events once capacity is exceeded', () => {
    const log = createEventLog({ capacity: 2 })

    log.publish({ type: 'stop', sessionId: 's1', title: 'a', cwd: '/a' })
    const second = log.publish({ type: 'stop', sessionId: 's1', title: 'b', cwd: '/b' })
    const third = log.publish({ type: 'stop', sessionId: 's1', title: 'c', cwd: '/c' })

    expect(log.history()).toEqual([second, third])
  })
})
