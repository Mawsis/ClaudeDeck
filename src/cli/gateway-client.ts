/**
 * gateway-client: the CLI's one door to the gateway. Every network call the
 * CLI makes goes through here, and every failure comes back as a typed
 * result — never a raw throw — so install flows can refuse to touch a file
 * on anything short of a verified gateway.
 */

export type GatewayError =
  | { readonly ok: false; readonly error: 'unreachable'; readonly detail: string }
  | { readonly ok: false; readonly error: 'unauthorized'; readonly status: 401 | 403 }
  | { readonly ok: false; readonly error: 'http'; readonly status: number }

export type GatewayResult<T> = { readonly ok: true; readonly value: T } | GatewayError

export type GatewayClient = {
  health(): Promise<GatewayResult<true>>
  verifyHookToken(hookToken: string): Promise<GatewayResult<true>>
  getPaused(deckToken: string): Promise<GatewayResult<boolean>>
  setPaused(deckToken: string, paused: boolean): Promise<GatewayResult<boolean>>
  handshake(
    hookToken: string,
    session: { readonly sessionId: string; readonly cwd: string },
  ): Promise<GatewayResult<number>>
}

type FetchLike = (url: string, init?: RequestInit) => Promise<Response>

export function createGatewayClient(
  gatewayUrl: string,
  fetchImpl: FetchLike = fetch,
): GatewayClient {
  const base = gatewayUrl.replace(/\/+$/, '')

  async function request(
    path: string,
    init: RequestInit & { readonly token?: string } = {},
  ): Promise<GatewayResult<Response>> {
    const { token, ...rest } = init
    let response: Response
    try {
      response = await fetchImpl(`${base}${path}`, {
        ...rest,
        headers: {
          ...(token === undefined ? {} : { Authorization: `Bearer ${token}` }),
          ...(rest.body === undefined ? {} : { 'Content-Type': 'application/json' }),
        },
      })
    } catch (error) {
      return {
        ok: false,
        error: 'unreachable',
        detail: error instanceof Error ? error.message : String(error),
      }
    }
    if (response.status === 401 || response.status === 403) {
      return { ok: false, error: 'unauthorized', status: response.status }
    }
    if (!response.ok) return { ok: false, error: 'http', status: response.status }
    return { ok: true, value: response }
  }

  async function requestJson(
    path: string,
    init: RequestInit & { readonly token?: string } = {},
  ): Promise<GatewayResult<Record<string, unknown>>> {
    const result = await request(path, init)
    if (!result.ok) return result
    let body: unknown
    try {
      body = await result.value.json()
    } catch {
      return { ok: false, error: 'http', status: result.value.status }
    }
    if (typeof body !== 'object' || body === null) {
      return { ok: false, error: 'http', status: result.value.status }
    }
    return { ok: true, value: body as Record<string, unknown> }
  }

  return {
    async health() {
      const result = await request('/')
      return result.ok ? { ok: true, value: true } : result
    },

    async verifyHookToken(hookToken) {
      const result = await request('/api/hook-check', { token: hookToken })
      return result.ok ? { ok: true, value: true } : result
    },

    async getPaused(deckToken) {
      const result = await requestJson('/api/deck-config', { token: deckToken })
      return result.ok ? { ok: true, value: result.value.paused === true } : result
    },

    async setPaused(deckToken, paused) {
      const result = await requestJson('/api/pause', {
        method: 'POST',
        token: deckToken,
        body: JSON.stringify({ paused }),
      })
      return result.ok ? { ok: true, value: result.value.paused === true } : result
    },

    async handshake(hookToken, session) {
      const result = await requestJson('/api/events', {
        method: 'POST',
        token: hookToken,
        body: JSON.stringify({
          hook_event_name: 'Handshake',
          session_id: session.sessionId,
          cwd: session.cwd,
        }),
      })
      if (!result.ok) return result
      return { ok: true, value: typeof result.value.id === 'number' ? result.value.id : -1 }
    },
  }
}
