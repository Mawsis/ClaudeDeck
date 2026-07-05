import { describe, expect, it } from 'vitest'
import { createApp } from '../src/gateway/app.ts'
import { createWorkspaceStore } from '../src/gateway/workspace-store.ts'

/**
 * Backward compatibility: a deployment that already has SLOPDECK_HOOK_TOKEN and
 * SLOPDECK_DECK_TOKEN in its .env keeps working when those two static tokens are
 * seeded as the hook key and deck key of one implicit workspace. The exact
 * tokens already deployed must still post events and read the stream — no
 * reconfiguration on upgrade.
 */
const ENV_HOOK_TOKEN = 'legacy-hook-token-0123456789abcdef'
const ENV_DECK_TOKEN = 'legacy-deck-token-0123456789abcdef'

function seededApp() {
  const store = createWorkspaceStore()
  store.seedWorkspace(ENV_HOOK_TOKEN, ENV_DECK_TOKEN)
  return createApp({ workspaceStore: store }).app
}

describe('env-token backward compatibility', () => {
  it('accepts the legacy hook token on ingest and lands the event on the legacy deck stream', async () => {
    const app = seededApp()

    const stream = await app.request(`/api/stream?token=${ENV_DECK_TOKEN}`)
    expect(stream.status).toBe(200)
    const reader = stream.body!.getReader()

    const posted = await app.request('/api/events', {
      method: 'POST',
      headers: { Authorization: `Bearer ${ENV_HOOK_TOKEN}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ hook_event_name: 'Stop', session_id: 's1', cwd: '/w/legacy' }),
    })
    expect(posted.status).toBe(202)

    const frame = new TextDecoder().decode((await reader.read()).value)
    expect(frame).toContain('"title":"legacy"')
    await reader.cancel()
  })

  it('still enforces scope — the legacy deck token is rejected at the hook door with 403', async () => {
    const app = seededApp()

    const response = await app.request('/api/events', {
      method: 'POST',
      headers: { Authorization: `Bearer ${ENV_DECK_TOKEN}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ hook_event_name: 'Stop', session_id: 's1', cwd: '/w/legacy' }),
    })

    expect(response.status).toBe(403)
  })
})
