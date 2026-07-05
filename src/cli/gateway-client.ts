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

/** A freshly minted workspace: the id plus its hook and deck key material. */
export type WorkspaceKeys = {
  readonly workspaceId: string
  readonly hookKey: string
  readonly deckKey: string
}

/** A rotation's fresh pair — same workspace, new keys, both old ones now dead. */
export type RotatedKeys = {
  readonly hookKey: string
  readonly deckKey: string
}

export type GatewayClient = {
  health(): Promise<GatewayResult<true>>
  verifyHookToken(hookToken: string): Promise<GatewayResult<true>>
  getPaused(deckToken: string): Promise<GatewayResult<boolean>>
  setPaused(deckToken: string, paused: boolean): Promise<GatewayResult<boolean>>
  handshake(
    hookToken: string,
    session: { readonly sessionId: string; readonly cwd: string },
  ): Promise<GatewayResult<number>>
  /** Mint a fresh workspace against the ungated local endpoint (local install). */
  mintLocal(): Promise<GatewayResult<WorkspaceKeys>>
  /** Mint a fresh workspace against the public, rate-limited hosted endpoint. */
  mintHosted(): Promise<GatewayResult<WorkspaceKeys>>
  /** Re-inscribe the workspace behind `currentKey`; both old keys stop working. */
  rotate(currentKey: string): Promise<GatewayResult<RotatedKeys>>
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

    async mintLocal() {
      return mintAt('/api/mint/local')
    },

    async mintHosted() {
      return mintAt('/api/mint/hosted')
    },

    async rotate(currentKey) {
      const result = await requestJson('/api/rotate', { method: 'POST', token: currentKey })
      if (!result.ok) return result
      const pair = readPair(result.value)
      // A 2xx whose body is not the documented key pair is a gateway/version
      // mismatch, not success — surface it as an http error, never half-data.
      if (pair === null) return { ok: false, error: 'http', status: 200 }
      return { ok: true, value: pair }
    },
  }

  async function mintAt(path: string): Promise<GatewayResult<WorkspaceKeys>> {
    const result = await requestJson(path, { method: 'POST' })
    if (!result.ok) return result
    const pair = readPair(result.value)
    const { workspaceId } = result.value
    if (pair === null || typeof workspaceId !== 'string' || workspaceId === '') {
      return { ok: false, error: 'http', status: 201 }
    }
    return { ok: true, value: { workspaceId, ...pair } }
  }
}

/** Extract the hook+deck key pair from a response body, or null if malformed. */
function readPair(body: Record<string, unknown>): RotatedKeys | null {
  const { hookKey, deckKey } = body
  if (typeof hookKey !== 'string' || hookKey === '') return null
  if (typeof deckKey !== 'string' || deckKey === '') return null
  return { hookKey, deckKey }
}
