/**
 * gateway-client: the CLI's one door to the gateway. Every network call the
 * CLI makes goes through here, and every failure comes back as a typed
 * result — never a raw throw — so install flows can refuse to touch a file
 * on anything short of a verified gateway.
 */
export function createGatewayClient(gatewayUrl, fetchImpl = fetch) {
    const base = gatewayUrl.replace(/\/+$/, '');
    async function request(path, init = {}) {
        const { token, ...rest } = init;
        let response;
        try {
            response = await fetchImpl(`${base}${path}`, {
                ...rest,
                headers: {
                    ...(token === undefined ? {} : { Authorization: `Bearer ${token}` }),
                    ...(rest.body === undefined ? {} : { 'Content-Type': 'application/json' }),
                },
            });
        }
        catch (error) {
            return {
                ok: false,
                error: 'unreachable',
                detail: error instanceof Error ? error.message : String(error),
            };
        }
        if (response.status === 401 || response.status === 403) {
            return { ok: false, error: 'unauthorized', status: response.status };
        }
        if (!response.ok)
            return { ok: false, error: 'http', status: response.status };
        return { ok: true, value: response };
    }
    async function requestJson(path, init = {}) {
        const result = await request(path, init);
        if (!result.ok)
            return result;
        let body;
        try {
            body = await result.value.json();
        }
        catch {
            return { ok: false, error: 'http', status: result.value.status };
        }
        if (typeof body !== 'object' || body === null) {
            return { ok: false, error: 'http', status: result.value.status };
        }
        return { ok: true, value: body };
    }
    return {
        async health() {
            const result = await request('/');
            return result.ok ? { ok: true, value: true } : result;
        },
        async verifyHookToken(hookToken) {
            const result = await request('/api/hook-check', { token: hookToken });
            return result.ok ? { ok: true, value: true } : result;
        },
        async getPaused(deckToken) {
            const result = await requestJson('/api/deck-config', { token: deckToken });
            return result.ok ? { ok: true, value: result.value.paused === true } : result;
        },
        async setPaused(deckToken, paused) {
            const result = await requestJson('/api/pause', {
                method: 'POST',
                token: deckToken,
                body: JSON.stringify({ paused }),
            });
            return result.ok ? { ok: true, value: result.value.paused === true } : result;
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
            });
            if (!result.ok)
                return result;
            return { ok: true, value: typeof result.value.id === 'number' ? result.value.id : -1 };
        },
        async mintLocal() {
            return mintAt('/api/mint/local');
        },
        async mintHosted() {
            return mintAt('/api/mint/hosted');
        },
        async rotate(currentKey) {
            const result = await requestJson('/api/rotate', { method: 'POST', token: currentKey });
            if (!result.ok)
                return result;
            const pair = readPair(result.value);
            // A 2xx whose body is not the documented key pair is a gateway/version
            // mismatch, not success — surface it as an http error, never half-data.
            if (pair === null)
                return { ok: false, error: 'http', status: 200 };
            return { ok: true, value: pair };
        },
    };
    async function mintAt(path) {
        const result = await requestJson(path, { method: 'POST' });
        if (!result.ok)
            return result;
        const pair = readPair(result.value);
        const { workspaceId } = result.value;
        if (pair === null || typeof workspaceId !== 'string' || workspaceId === '') {
            return { ok: false, error: 'http', status: 201 };
        }
        return { ok: true, value: { workspaceId, ...pair } };
    }
}
/** Extract the hook+deck key pair from a response body, or null if malformed. */
function readPair(body) {
    const { hookKey, deckKey } = body;
    if (typeof hookKey !== 'string' || hookKey === '')
        return null;
    if (typeof deckKey !== 'string' || deckKey === '')
        return null;
    return { hookKey, deckKey };
}
