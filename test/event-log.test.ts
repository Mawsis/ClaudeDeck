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

  it('stamps each event with the publish time so replayed events stay truthful', () => {
    let clock = 10_000
    const log = createEventLog({ now: () => clock })

    const first = log.publish({ type: 'prompt', sessionId: 's1', title: 'a', cwd: '/a' })
    clock = 55_000
    const second = log.publish({ type: 'stop', sessionId: 's1', title: 'a', cwd: '/a' })

    expect(first.at).toBe(10_000)
    expect(second.at).toBe(55_000)
  })

  it('replays exactly the events after a given id', () => {
    const log = createEventLog()

    log.publish({ type: 'prompt', sessionId: 's1', title: 'a', cwd: '/a' })
    const second = log.publish({ type: 'stop', sessionId: 's1', title: 'a', cwd: '/a' })
    const third = log.publish({ type: 'prompt', sessionId: 's2', title: 'b', cwd: '/b' })

    expect(log.since(1)).toEqual([second, third])
    expect(log.since(3)).toEqual([])
  })

  it('replays only what the ring buffer still holds when older events were evicted', () => {
    const log = createEventLog({ capacity: 2 })

    log.publish({ type: 'prompt', sessionId: 's1', title: 'a', cwd: '/a' })
    log.publish({ type: 'stop', sessionId: 's1', title: 'a', cwd: '/a' })
    const third = log.publish({ type: 'prompt', sessionId: 's1', title: 'a', cwd: '/a' })
    const fourth = log.publish({ type: 'stop', sessionId: 's1', title: 'a', cwd: '/a' })

    // Client last saw id 1; ids 2 fell out of the buffer — only 3 and 4 survive.
    expect(log.since(1)).toEqual([third, fourth])
  })
})
