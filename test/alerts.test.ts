import { describe, expect, it, vi } from 'vitest'
import type { AlertsConfig } from '../src/gateway/app.ts'
import { buildApp, DECK_TOKEN, HOOK_TOKEN } from './helpers.ts'

const subscription = {
  endpoint: 'https://push.example.com/sub/1',
  keys: { p256dh: 'p256dh-key', auth: 'auth-key' },
}

function post(app: ReturnType<typeof buildApp>['app'], path: string, token: string | undefined, body: unknown) {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' }
  if (token !== undefined) headers.Authorization = `Bearer ${token}`
  return app.request(path, { method: 'POST', headers, body: JSON.stringify(body) })
}

function hookPayload(hookEventName: 'UserPromptSubmit' | 'Stop') {
  return {
    hook_event_name: hookEventName,
    session_id: 'sess-42',
    cwd: '/Users/mac/Workshop/Personal/my-app',
  }
}

/** An app on a controllable clock with a recording push sender. */
function buildAlertingApp(alerts: AlertsConfig = {}) {
  const sendPush = vi.fn<(subscription: unknown, payload: string) => Promise<void>>(() =>
    Promise.resolve(),
  )
  const clock = { now: 100_000 }
  const { app } = buildApp({ now: () => clock.now, alerts: { sendPush, ...alerts } })
  return { app, sendPush, clock }
}

async function runTurn(
  app: ReturnType<typeof buildApp>['app'],
  clock: { now: number },
  durationMs: number,
) {
  await post(app, '/api/events', HOOK_TOKEN, hookPayload('UserPromptSubmit'))
  clock.now += durationMs
  await post(app, '/api/events', HOOK_TOKEN, hookPayload('Stop'))
}

describe('completion push alerts', () => {
  it('pushes a threshold-crossing stop to a registered subscription, payload carrying the session title', async () => {
    const { app, sendPush, clock } = buildAlertingApp()

    const registered = await post(app, '/api/push/subscriptions', DECK_TOKEN, subscription)
    await runTurn(app, clock, 60_000)

    expect(registered.status).toBe(201)
    expect(sendPush).toHaveBeenCalledTimes(1)
    const [sent, payload] = sendPush.mock.calls[0]!
    expect(sent).toEqual(subscription)
    expect(JSON.parse(payload)).toMatchObject({ title: 'my-app' })
  })

  it('stays silent for a sub-threshold turn — no push on any channel', async () => {
    const { app, sendPush, clock } = buildAlertingApp()

    await post(app, '/api/push/subscriptions', DECK_TOKEN, subscription)
    await runTurn(app, clock, 10_000)

    expect(sendPush).not.toHaveBeenCalled()
  })

  it('honors a configured threshold', async () => {
    const { app, sendPush, clock } = buildAlertingApp({ thresholdMs: 5_000 })

    await post(app, '/api/push/subscriptions', DECK_TOKEN, subscription)
    await runTurn(app, clock, 10_000)

    expect(sendPush).toHaveBeenCalledTimes(1)
  })

  it('treats re-registration on reconnect as idempotent — one device, one push', async () => {
    const { app, sendPush, clock } = buildAlertingApp()

    await post(app, '/api/push/subscriptions', DECK_TOKEN, subscription)
    await post(app, '/api/push/subscriptions', DECK_TOKEN, subscription)
    await runTurn(app, clock, 60_000)

    expect(sendPush).toHaveBeenCalledTimes(1)
  })

  it('accepts a threshold-crossing stop without a push sender — push disabled, ingest unaffected', async () => {
    const clock = { now: 100_000 }
    const { app } = buildApp({ now: () => clock.now })

    await post(app, '/api/events', HOOK_TOKEN, hookPayload('UserPromptSubmit'))
    clock.now += 60_000
    const response = await post(app, '/api/events', HOOK_TOKEN, hookPayload('Stop'))

    expect(response.status).toBe(202)
  })

  it('prunes a subscription the push service reports gone, keeps one that failed transiently', async () => {
    const { app, sendPush, clock } = buildAlertingApp()
    const gone = { endpoint: 'https://push.example.com/gone', keys: subscription.keys }
    sendPush.mockImplementation((sent) =>
      (sent as typeof gone).endpoint === gone.endpoint
        ? Promise.reject(Object.assign(new Error('Gone'), { statusCode: 410 }))
        : Promise.reject(new Error('socket hang up')),
    )

    await post(app, '/api/push/subscriptions', DECK_TOKEN, subscription)
    await post(app, '/api/push/subscriptions', DECK_TOKEN, gone)
    await runTurn(app, clock, 60_000)
    // The prune happens in a rejection handler — let microtasks settle.
    await new Promise((resolve) => setTimeout(resolve, 0))

    sendPush.mockClear()
    sendPush.mockImplementation(() => Promise.resolve())
    await runTurn(app, clock, 60_000)

    expect(sendPush).toHaveBeenCalledTimes(1)
    expect(sendPush.mock.calls[0]![0]).toEqual(subscription)
  })

  it('caps the registry — the longest-silent endpoint is evicted, not the reconnecting one', async () => {
    const { app, sendPush, clock } = buildAlertingApp()
    const endpoints = Array.from({ length: 9 }, (_, i) => `https://push.example.com/sub/${i}`)

    for (const endpoint of endpoints) {
      await post(app, '/api/push/subscriptions', DECK_TOKEN, { endpoint, keys: subscription.keys })
    }
    await runTurn(app, clock, 60_000)

    expect(sendPush).toHaveBeenCalledTimes(8)
    const sentEndpoints = sendPush.mock.calls.map((call) => (call[0] as { endpoint: string }).endpoint)
    expect(sentEndpoints).not.toContain(endpoints[0])
  })
})

describe('deck config endpoint', () => {
  it('tells the deck its alert threshold and the VAPID public key', async () => {
    const { app } = buildAlertingApp({ thresholdMs: 30_000, vapidPublicKey: 'vapid-pub' })

    const response = await app.request('/api/deck-config', {
      headers: { Authorization: `Bearer ${DECK_TOKEN}` },
    })

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ alertThresholdMs: 30_000, vapidPublicKey: 'vapid-pub' })
  })

  it('reports push unavailable with a null key, and defaults the threshold to 45s', async () => {
    const { app } = buildApp()

    const response = await app.request('/api/deck-config', {
      headers: { Authorization: `Bearer ${DECK_TOKEN}` },
    })

    expect(await response.json()).toEqual({ alertThresholdMs: 45_000, vapidPublicKey: null })
  })

  it('is deck-scoped — the hook token is refused', async () => {
    const { app } = buildApp()

    const response = await app.request('/api/deck-config', {
      headers: { Authorization: `Bearer ${HOOK_TOKEN}` },
    })

    expect(response.status).toBe(403)
  })
})

describe('push subscription endpoint', () => {
  it('rejects the hook token — wrong scope — and a missing token', async () => {
    const { app } = buildAlertingApp()

    expect((await post(app, '/api/push/subscriptions', HOOK_TOKEN, subscription)).status).toBe(403)
    expect((await post(app, '/api/push/subscriptions', undefined, subscription)).status).toBe(401)
  })

  it('rejects a body that is not a Web Push subscription', async () => {
    const { app } = buildAlertingApp()

    for (const bad of [null, {}, { endpoint: 'https://x' }, { endpoint: '', keys: subscription.keys }, { endpoint: 'https://x', keys: { p256dh: 'k' } }]) {
      expect((await post(app, '/api/push/subscriptions', DECK_TOKEN, bad)).status).toBe(400)
    }
  })

  it('rejects a non-https endpoint — push services are https-only; anything else is an SSRF target', async () => {
    const { app } = buildAlertingApp()

    for (const endpoint of ['http://internal.host/steal', 'file:///etc/passwd', 'not a url']) {
      const response = await post(app, '/api/push/subscriptions', DECK_TOKEN, {
        endpoint,
        keys: subscription.keys,
      })
      expect(response.status).toBe(400)
    }
  })
})
