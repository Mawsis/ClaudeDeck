import { describe, expect, it } from 'vitest'
import { createApp } from '../src/gateway/app.ts'
import { createEventLog } from '../src/gateway/event-log.ts'

const HOOK_TOKEN = 'hook-token-for-tests-0123456789abcdef'
const DECK_TOKEN = 'deck-token-for-tests-0123456789abcdef'

function buildApp() {
  const eventLog = createEventLog()
  return createApp({ hookToken: HOOK_TOKEN, deckToken: DECK_TOKEN, eventLog })
}

describe('PWA shell', () => {
  it('serves the deck page at the root without auth', async () => {
    const app = buildApp()

    const response = await app.request('/')

    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toContain('text/html')
    expect(await response.text()).toContain('ClaudeDeck')
  })
})
