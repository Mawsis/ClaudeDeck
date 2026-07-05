import { describe, expect, it } from 'vitest'
import { createApp } from '../src/gateway/app.ts'
import { createWorkspaceStore } from '../src/gateway/workspace-store.ts'

/**
 * Mint endpoints turn "run install" into a fresh workspace with no token typed
 * by hand. Local mint is ungated — localhost is the trust boundary. Hosted mint
 * is a public endpoint, so it is IP-rate-limited to keep a bot from minting
 * thousands of ephemeral workspaces and exhausting disk.
 */

function mintApp(
  options: {
    mint?: { local?: boolean; hostedRateLimit?: { max: number; windowMs: number } }
    now?: () => number
  } = {},
) {
  const store = createWorkspaceStore(options.now ? { now: options.now } : {})
  const { app } = createApp({
    workspaceStore: store,
    ...(options.now ? { now: options.now } : {}),
    ...(options.mint ? { mint: options.mint } : {}),
  })
  return { app, store }
}

/** A hosted request carries its client IP in x-forwarded-for behind the proxy. */
function fromIp(ip: string): RequestInit {
  return { method: 'POST', headers: { 'x-forwarded-for': ip } }
}

describe('mint: local (ungated, local-mode only)', () => {
  it('returns a fresh workspace with a hook key and deck key, no auth required', async () => {
    const { app, store } = mintApp({ mint: { local: true } })

    const response = await app.request('/api/mint/local', { method: 'POST' })

    expect(response.status).toBe(201)
    const body = (await response.json()) as {
      workspaceId: string
      hookKey: string
      deckKey: string
    }
    expect(body.workspaceId).toBeTruthy()
    // The minted keys really authenticate their new workspace.
    expect(store.authenticateScoped(body.hookKey)).toEqual({
      workspaceId: body.workspaceId,
      scope: 'hook',
    })
    expect(store.authenticateScoped(body.deckKey)).toEqual({
      workspaceId: body.workspaceId,
      scope: 'deck',
    })
  })

  it('mints a distinct workspace on each call', async () => {
    const { app } = mintApp({ mint: { local: true } })

    const a = (await (await app.request('/api/mint/local', { method: 'POST' })).json()) as {
      workspaceId: string
    }
    const b = (await (await app.request('/api/mint/local', { method: 'POST' })).json()) as {
      workspaceId: string
    }

    expect(a.workspaceId).not.toBe(b.workspaceId)
  })

  it('is NOT registered unless local mode is enabled — a hosted gateway never exposes ungated mint', async () => {
    // The trust boundary for local mint is localhost; a hosted deployment must
    // never expose an unauthenticated workspace factory behind its public TLS.
    // With no local flag, the route simply does not exist → 404.
    const { app } = mintApp({ mint: { hostedRateLimit: { max: 5, windowMs: 60_000 } } })

    const response = await app.request('/api/mint/local', { method: 'POST' })

    expect(response.status).toBe(404)
  })

  it('is absent by default — the safe default is no ungated mint endpoint at all', async () => {
    const { app } = mintApp()

    const response = await app.request('/api/mint/local', { method: 'POST' })

    expect(response.status).toBe(404)
  })
})

describe('mint: hosted (IP-rate-limited)', () => {
  it('mints up to the per-IP limit, then rejects further mints from that IP with 429', async () => {
    const { app } = mintApp({ mint: { hostedRateLimit: { max: 2, windowMs: 60_000 } } })

    const first = await app.request('/api/mint/hosted', fromIp('203.0.113.7'))
    const second = await app.request('/api/mint/hosted', fromIp('203.0.113.7'))
    const third = await app.request('/api/mint/hosted', fromIp('203.0.113.7'))

    expect(first.status).toBe(201)
    expect(second.status).toBe(201)
    expect(third.status).toBe(429)
  })

  it('rate-limits per IP — a different IP is unaffected by another IP hitting the cap', async () => {
    const { app } = mintApp({ mint: { hostedRateLimit: { max: 1, windowMs: 60_000 } } })

    await app.request('/api/mint/hosted', fromIp('198.51.100.1'))
    const blocked = await app.request('/api/mint/hosted', fromIp('198.51.100.1'))
    const otherIp = await app.request('/api/mint/hosted', fromIp('198.51.100.2'))

    expect(blocked.status).toBe(429)
    expect(otherIp.status).toBe(201)
  })

  it('keys the limit on the proxy-appended (right-most) X-Forwarded-For hop, not a client-spoofable left-most one', async () => {
    const { app } = mintApp({ mint: { hostedRateLimit: { max: 1, windowMs: 60_000 } } })

    // Behind one reverse proxy, the real client IP is the RIGHT-most XFF entry
    // (the proxy appends it); the left-most is whatever the client typed. An
    // attacker rotates the left-most value to try to dodge the limit — but the
    // real client IP the proxy appended is constant, so the second mint is still
    // rejected.
    const spoofA: RequestInit = {
      method: 'POST',
      headers: { 'x-forwarded-for': '1.1.1.1, 203.0.113.9' },
    }
    const spoofB: RequestInit = {
      method: 'POST',
      headers: { 'x-forwarded-for': '2.2.2.2, 203.0.113.9' },
    }

    const first = await app.request('/api/mint/hosted', spoofA)
    const second = await app.request('/api/mint/hosted', spoofB)

    expect(first.status).toBe(201)
    expect(second.status).toBe(429)
  })

  it('lets an IP mint again once its window has elapsed', async () => {
    let clock = 1_000
    const { app } = mintApp({
      now: () => clock,
      mint: { hostedRateLimit: { max: 1, windowMs: 10_000 } },
    })

    const first = await app.request('/api/mint/hosted', fromIp('192.0.2.5'))
    const blocked = await app.request('/api/mint/hosted', fromIp('192.0.2.5'))
    // Advance past the window: the earlier hit no longer counts.
    clock = 12_000
    const afterWindow = await app.request('/api/mint/hosted', fromIp('192.0.2.5'))

    expect(first.status).toBe(201)
    expect(blocked.status).toBe(429)
    expect(afterWindow.status).toBe(201)
  })
})
