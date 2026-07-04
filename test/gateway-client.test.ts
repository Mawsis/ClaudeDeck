import { serve } from '@hono/node-server'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createGatewayClient } from '../src/cli/gateway-client.ts'
import { buildApp, DECK_TOKEN, HOOK_TOKEN } from './helpers.ts'

// The client is exercised against a real HTTP server running the real
// gateway app — typed results must come from genuine wire behavior.
let server: ReturnType<typeof serve>
let baseUrl: string
let eventLog: ReturnType<typeof buildApp>['eventLog']

beforeAll(async () => {
  const built = buildApp()
  eventLog = built.eventLog
  await new Promise<void>((resolve) => {
    server = serve({ fetch: built.app.fetch, port: 0 }, (info) => {
      baseUrl = `http://127.0.0.1:${info.port}`
      resolve()
    })
  })
})

afterAll(() => {
  server.close()
})

describe('gateway-client', () => {
  it('health-checks a live gateway', async () => {
    const client = createGatewayClient(baseUrl)

    expect(await client.health()).toEqual({ ok: true, value: true })
  })

  it('reports an unreachable host as a typed error, never a raw throw', async () => {
    const client = createGatewayClient('http://127.0.0.1:9')

    const result = await client.health()

    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error).toBe('unreachable')
  })

  it('verifies a good hook token and rejects a bad one as typed unauthorized', async () => {
    const client = createGatewayClient(baseUrl)

    expect(await client.verifyHookToken(HOOK_TOKEN)).toEqual({ ok: true, value: true })

    const rejected = await client.verifyHookToken('wrong-token')
    expect(rejected).toEqual({ ok: false, error: 'unauthorized', status: 401 })
  })

  it('reads and sets pause through the deck scope', async () => {
    const client = createGatewayClient(baseUrl)

    expect(await client.getPaused(DECK_TOKEN)).toEqual({ ok: true, value: false })
    expect(await client.setPaused(DECK_TOKEN, true)).toEqual({ ok: true, value: true })
    expect(await client.getPaused(DECK_TOKEN)).toEqual({ ok: true, value: true })
    expect(await client.setPaused(DECK_TOKEN, false)).toEqual({ ok: true, value: false })
  })

  it('fires the handshake through the authenticated ingest path — it lands in the event log', async () => {
    const client = createGatewayClient(baseUrl)

    const result = await client.handshake(HOOK_TOKEN, { sessionId: 'install-1', cwd: '/tmp/install' })

    expect(result.ok).toBe(true)
    expect(eventLog.history().some((event) => event.type === 'handshake')).toBe(true)
  })

  it('surfaces a wrong-scope token as typed unauthorized (403), not success', async () => {
    const client = createGatewayClient(baseUrl)

    expect(await client.verifyHookToken(DECK_TOKEN)).toEqual({
      ok: false,
      error: 'unauthorized',
      status: 403,
    })
  })
})
