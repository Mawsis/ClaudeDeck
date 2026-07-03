import { createApp } from '../src/gateway/app.ts'
import { createEventLog } from '../src/gateway/event-log.ts'

export const HOOK_TOKEN = 'hook-token-for-tests-0123456789abcdef'
export const DECK_TOKEN = 'deck-token-for-tests-0123456789abcdef'

export function buildApp() {
  const eventLog = createEventLog()
  const app = createApp({ hookToken: HOOK_TOKEN, deckToken: DECK_TOKEN, eventLog })
  return { app, eventLog }
}
