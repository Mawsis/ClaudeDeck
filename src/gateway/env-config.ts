import { DEFAULT_ALERT_THRESHOLD_MS } from '../pwa/deck-reducer.js'

export type VapidConfig = {
  readonly publicKey: string
  readonly privateKey: string
  readonly subject: string
}

export type GatewayConfig = {
  readonly hookToken: string
  readonly deckToken: string
  readonly port: number
  readonly alertThresholdMs: number
  /** Absent → Web Push disabled; in-page alerts are unaffected. */
  readonly vapid: VapidConfig | undefined
}

const DEFAULT_PORT = 8484

function requireVar(env: Record<string, string | undefined>, name: string): string {
  const value = env[name]
  if (value === undefined || value === '') {
    throw new Error(`missing required environment variable ${name}`)
  }
  return value
}

function loadAlertThreshold(env: Record<string, string | undefined>): number {
  const raw = env.CLAUDEDECK_ALERT_THRESHOLD_MS
  if (raw === undefined || raw === '') return DEFAULT_ALERT_THRESHOLD_MS
  const thresholdMs = Number(raw)
  if (!Number.isSafeInteger(thresholdMs) || thresholdMs < 1) {
    throw new Error(`CLAUDEDECK_ALERT_THRESHOLD_MS must be a positive integer of milliseconds, got ${raw}`)
  }
  return thresholdMs
}

/** All-or-nothing: a partial trio is a misconfiguration, not "push disabled". */
function loadVapid(env: Record<string, string | undefined>): VapidConfig | undefined {
  const names = [
    'CLAUDEDECK_VAPID_PUBLIC_KEY',
    'CLAUDEDECK_VAPID_PRIVATE_KEY',
    'CLAUDEDECK_VAPID_SUBJECT',
  ] as const
  const present = names.filter((name) => env[name] !== undefined && env[name] !== '')
  if (present.length === 0) return undefined
  if (present.length < names.length) {
    const missing = names.filter((name) => !present.includes(name))
    throw new Error(`incomplete VAPID configuration — missing ${missing.join(', ')}`)
  }
  return {
    publicKey: requireVar(env, 'CLAUDEDECK_VAPID_PUBLIC_KEY'),
    privateKey: requireVar(env, 'CLAUDEDECK_VAPID_PRIVATE_KEY'),
    subject: requireVar(env, 'CLAUDEDECK_VAPID_SUBJECT'),
  }
}

export function loadConfigFromEnv(env: Record<string, string | undefined>): GatewayConfig {
  const hookToken = requireVar(env, 'CLAUDEDECK_HOOK_TOKEN')
  const deckToken = requireVar(env, 'CLAUDEDECK_DECK_TOKEN')
  if (hookToken === deckToken) {
    throw new Error('CLAUDEDECK_HOOK_TOKEN and CLAUDEDECK_DECK_TOKEN are identical — scopes must use distinct tokens')
  }

  const rawPort = env.PORT
  const port = rawPort === undefined || rawPort === '' ? DEFAULT_PORT : Number.parseInt(rawPort, 10)
  if (Number.isNaN(port) || port < 1 || port > 65535) {
    throw new Error(`PORT must be a number between 1 and 65535, got ${rawPort}`)
  }

  return {
    hookToken,
    deckToken,
    port,
    alertThresholdMs: loadAlertThreshold(env),
    vapid: loadVapid(env),
  }
}
