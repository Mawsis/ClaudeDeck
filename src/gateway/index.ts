import { serve } from '@hono/node-server'
import webpush from 'web-push'
import { createApp, type AlertsConfig } from './app.ts'
import { createEventLog } from './event-log.ts'
import { loadConfigFromEnv } from './env-config.ts'

const config = loadConfigFromEnv(process.env)

let alerts: AlertsConfig = { thresholdMs: config.alertThresholdMs }
if (config.vapid !== undefined) {
  webpush.setVapidDetails(config.vapid.subject, config.vapid.publicKey, config.vapid.privateKey)
  alerts = {
    ...alerts,
    vapidPublicKey: config.vapid.publicKey,
    sendPush: async (subscription, payload) => {
      await webpush.sendNotification(subscription, payload)
    },
  }
}

const app = createApp({
  hookToken: config.hookToken,
  deckToken: config.deckToken,
  eventLog: createEventLog(),
  alerts,
  questionTimeoutMs: config.questionTimeoutMs,
})

serve({ fetch: app.fetch, port: config.port }, (info) => {
  console.log(
    `slopdeck gateway listening on :${info.port}` +
      (config.vapid === undefined ? ' (web push disabled — no VAPID keys)' : ''),
  )
})
