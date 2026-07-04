import { describe, expect, it } from 'vitest'
import { createApp } from '../src/gateway/app.ts'
import { createEventLog } from '../src/gateway/event-log.ts'
import { buildApp, DECK_TOKEN, HOOK_TOKEN } from './helpers.ts'

describe('SSE stream', () => {
  it('streams published events to a deck-token client as SSE frames with ids', async () => {
    const { app, eventLog } = buildApp()

    const response = await app.request(`/api/stream?token=${DECK_TOKEN}`)
    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toContain('text/event-stream')

    const reader = response.body!.getReader()
    eventLog.publish({ type: 'stop', sessionId: 'sess-42', title: 'my-app', cwd: '/w/my-app' })

    const { value } = await reader.read()
    const frame = new TextDecoder().decode(value)
    expect(frame).toContain('id: 1')
    expect(frame).toContain('event: stop')
    expect(frame).toContain('"title":"my-app"')
    await reader.cancel()
  })

  it('replays the events missed since Last-Event-ID before streaming live ones', async () => {
    const { app, eventLog } = buildApp()
    eventLog.publish({ type: 'prompt', sessionId: 's1', title: 'seen', cwd: '/w/seen' })
    eventLog.publish({ type: 'stop', sessionId: 's1', title: 'missed-stop', cwd: '/w/seen' })
    eventLog.publish({ type: 'prompt', sessionId: 's2', title: 'missed-prompt', cwd: '/w/other' })

    const response = await app.request(`/api/stream?token=${DECK_TOKEN}`, {
      headers: { 'Last-Event-ID': '1' },
    })
    const reader = response.body!.getReader()
    const decoder = new TextDecoder()

    let frames = ''
    while (!frames.includes('id: 3')) {
      frames += decoder.decode((await reader.read()).value)
    }
    expect(frames).not.toContain('"title":"seen"')
    expect(frames.indexOf('id: 2')).toBeLessThan(frames.indexOf('id: 3'))
    expect(frames).toContain('"title":"missed-stop"')
    expect(frames).toContain('"title":"missed-prompt"')

    // still live: a fresh event follows the replay on the same stream
    eventLog.publish({ type: 'stop', sessionId: 's2', title: 'live', cwd: '/w/other' })
    let tail = ''
    while (!tail.includes('id: 4')) {
      tail += decoder.decode((await reader.read()).value)
    }
    expect(tail).toContain('"title":"live"')
    await reader.cancel()
  })

  it('streams and replays a handshake like any other event — its own SSE name, same Last-Event-ID path', async () => {
    const { app, eventLog } = buildApp()
    eventLog.publish({ type: 'prompt', sessionId: 's1', title: 'seen', cwd: '/w/seen' })
    eventLog.publish({ type: 'handshake', sessionId: 'install-1', title: 'my-app', cwd: '/w/my-app' })

    const response = await app.request(`/api/stream?token=${DECK_TOKEN}`, {
      headers: { 'Last-Event-ID': '1' },
    })
    const reader = response.body!.getReader()
    const decoder = new TextDecoder()

    let frames = ''
    while (!frames.includes('id: 2')) {
      frames += decoder.decode((await reader.read()).value)
    }
    expect(frames).not.toContain('"title":"seen"')
    expect(frames).toContain('event: handshake')
    expect(frames).toContain('"title":"my-app"')
    await reader.cancel()
  })

  it.each(['garbage', '', '1.5', '-3'])(
    'ignores a malformed Last-Event-ID (%j) and streams only live events',
    async (lastEventId) => {
      const { app, eventLog } = buildApp()
      eventLog.publish({ type: 'stop', sessionId: 's1', title: 'old', cwd: '/w/old' })

      const response = await app.request(`/api/stream?token=${DECK_TOKEN}`, {
        headers: { 'Last-Event-ID': lastEventId },
      })
      const reader = response.body!.getReader()

      eventLog.publish({ type: 'stop', sessionId: 's1', title: 'fresh', cwd: '/w/old' })
      const frame = new TextDecoder().decode((await reader.read()).value)

      expect(frame).not.toContain('"title":"old"')
      expect(frame).toContain('"title":"fresh"')
      await reader.cancel()
    },
  )

  it('stamps every frame with serverNow so clients can rebase event age onto their own clock', async () => {
    let clock = 10_000
    const eventLog = createEventLog({ now: () => clock })
    const app = createApp({ hookToken: HOOK_TOKEN, deckToken: DECK_TOKEN, eventLog, now: () => clock })
    eventLog.publish({ type: 'prompt', sessionId: 's1', title: 'a', cwd: '/a' })
    eventLog.publish({ type: 'prompt', sessionId: 's1', title: 'a', cwd: '/a' })

    // The deck reconnects 60s later: the replayed frame is 60s old.
    clock = 70_000
    const response = await app.request(`/api/stream?token=${DECK_TOKEN}`, {
      headers: { 'Last-Event-ID': '1' },
    })
    const reader = response.body!.getReader()
    const replayed = new TextDecoder().decode((await reader.read()).value)
    expect(replayed).toContain('"at":10000')
    expect(replayed).toContain('"serverNow":70000')

    // A live frame has no age: serverNow equals its publish time.
    clock = 80_000
    eventLog.publish({ type: 'stop', sessionId: 's1', title: 'a', cwd: '/a' })
    const live = new TextDecoder().decode((await reader.read()).value)
    expect(live).toContain('"at":80000')
    expect(live).toContain('"serverNow":80000')
    await reader.cancel()
  })

  it('stamps every frame with a bootId stable per gateway process and distinct across restarts', async () => {
    // A restarted gateway restarts ids at 1; the bootId is what lets a deck
    // that stayed open tell a colliding new id apart from a replayed old one.
    const readBootId = async (app: ReturnType<typeof buildApp>['app'], eventLog: ReturnType<typeof buildApp>['eventLog']) => {
      const response = await app.request(`/api/stream?token=${DECK_TOKEN}`)
      const reader = response.body!.getReader()
      eventLog.publish({ type: 'stop', sessionId: 's', title: 'a', cwd: '/a' })
      const frame = new TextDecoder().decode((await reader.read()).value)
      await reader.cancel()
      return /"bootId":"([^"]+)"/.exec(frame)?.[1]
    }

    const first = buildApp()
    const bootA = await readBootId(first.app, first.eventLog)
    const bootAAgain = await readBootId(first.app, first.eventLog)
    const restarted = buildApp()
    const bootB = await readBootId(restarted.app, restarted.eventLog)

    expect(bootA).toBeTruthy()
    expect(bootAAgain).toBe(bootA)
    expect(bootB).toBeTruthy()
    expect(bootB).not.toBe(bootA)
  })

  it('rejects the hook token on the stream — wrong scope', async () => {
    const { app } = buildApp()

    const response = await app.request(`/api/stream?token=${HOOK_TOKEN}`)

    expect(response.status).toBe(403)
  })

  it('rejects a stream request with no token', async () => {
    const { app } = buildApp()

    const response = await app.request('/api/stream')

    expect(response.status).toBe(401)
  })

  it('evicts the oldest stream when the client cap is exceeded, keeping the newest live', async () => {
    const eventLog = createEventLog()
    const app = createApp({
      hookToken: HOOK_TOKEN,
      deckToken: DECK_TOKEN,
      eventLog,
      maxStreamClients: 1,
    })

    const first = await app.request(`/api/stream?token=${DECK_TOKEN}`)
    const firstReader = first.body!.getReader()
    const second = await app.request(`/api/stream?token=${DECK_TOKEN}`)
    const secondReader = second.body!.getReader()

    eventLog.publish({ type: 'stop', sessionId: 's', title: 'live', cwd: '/live' })

    const secondFrame = new TextDecoder().decode((await secondReader.read()).value)
    expect(secondFrame).toContain('"title":"live"')

    // the evicted stream closes instead of receiving the event
    const firstRead = await firstReader.read()
    expect(firstRead.done).toBe(true)

    await secondReader.cancel()
  })
})
