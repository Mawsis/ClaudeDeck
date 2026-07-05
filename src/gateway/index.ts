import { serve } from '@hono/node-server'
import webpush from 'web-push'
import { createApp, type AlertsConfig } from './app.ts'
import { loadConfigFromEnv } from './env-config.ts'
import { createWorkspaceStore } from './workspace-store.ts'

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

// Backward compatibility: if the two static env tokens are present, they become
// the hook key and deck key of one implicit pre-seeded workspace, so an existing
// deployment keeps working with the exact tokens already in its .env. Absent —
// the mint-only hosted case — the store starts empty and workspaces arrive via
// the mint endpoints.
const workspaceStore = createWorkspaceStore()
if (config.hookToken !== undefined && config.deckToken !== undefined) {
  workspaceStore.seedWorkspace(config.hookToken, config.deckToken)
}

const { app, sweepExpired } = createApp({
  workspaceStore,
  alerts,
  questionTimeoutMs: config.questionTimeoutMs,
  mint: {
    local: config.localMint,
    ...(config.hostedMint !== undefined ? { hostedRateLimit: config.hostedMint.rateLimit } : {}),
  },
})

// Ephemeral sweep: while hosted mint is on, periodically drop anonymous
// workspaces idle past the TTL — both the store row and the in-memory runtime.
// `touch` (on ingest and stream) keeps active ones alive, so only genuinely
// abandoned/abusive workspaces are collected.
if (config.hostedMint !== undefined) {
  const ttl = config.hostedMint.ephemeralTtlMs
  const sweep = setInterval(() => sweepExpired(Date.now() - ttl), ttl)
  // Don't let the sweep timer hold the process open on shutdown.
  sweep.unref()
}

serve({ fetch: app.fetch, port: config.port }, (info) => {
  console.log(
    `slopdeck gateway listening on :${info.port}` +
      (config.vapid === undefined ? ' (web push disabled — no VAPID keys)' : ''),
  )
})
