import { createApp, type AlertsConfig } from '../src/gateway/app.ts'
import { createEventLog } from '../src/gateway/event-log.ts'

export const HOOK_TOKEN = 'hook-token-for-tests-0123456789abcdef'
export const DECK_TOKEN = 'deck-token-for-tests-0123456789abcdef'

export function buildApp(options: { now?: () => number; alerts?: AlertsConfig } = {}) {
  const eventLog = createEventLog(options.now ? { now: options.now } : {})
  const app = createApp({
    hookToken: HOOK_TOKEN,
    deckToken: DECK_TOKEN,
    eventLog,
    ...(options.alerts ? { alerts: options.alerts } : {}),
  })
  return { app, eventLog }
}
