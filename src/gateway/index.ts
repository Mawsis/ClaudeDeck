import { serve } from '@hono/node-server'
import { createApp } from './app.ts'
import { createEventLog } from './event-log.ts'
import { loadConfigFromEnv } from './env-config.ts'

const config = loadConfigFromEnv(process.env)
const app = createApp({
  hookToken: config.hookToken,
  deckToken: config.deckToken,
  eventLog: createEventLog(),
})

serve({ fetch: app.fetch, port: config.port }, (info) => {
  console.log(`claudedeck gateway listening on :${info.port}`)
})
