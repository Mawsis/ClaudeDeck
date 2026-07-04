import { DEFAULT_ALERT_THRESHOLD_MS } from '../pwa/deck-reducer.js'
import { DEFAULT_QUESTION_TIMEOUT_MS } from './question-routes.ts'

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
  readonly questionTimeoutMs: number
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

function loadMillisVar(
  env: Record<string, string | undefined>,
  name: string,
  fallback: number,
): number {
  const raw = env[name]
  if (raw === undefined || raw === '') return fallback
  const millis = Number(raw)
  if (!Number.isSafeInteger(millis) || millis < 1) {
    throw new Error(`${name} must be a positive integer of milliseconds, got ${raw}`)
  }
  return millis
}

/** All-or-nothing: a partial trio is a misconfiguration, not "push disabled". */
function loadVapid(env: Record<string, string | undefined>): VapidConfig | undefined {
  const names = [
    'SLOPDECK_VAPID_PUBLIC_KEY',
    'SLOPDECK_VAPID_PRIVATE_KEY',
    'SLOPDECK_VAPID_SUBJECT',
  ] as const
  const present = names.filter((name) => env[name] !== undefined && env[name] !== '')
  if (present.length === 0) return undefined
  if (present.length < names.length) {
    const missing = names.filter((name) => !present.includes(name))
    throw new Error(`incomplete VAPID configuration — missing ${missing.join(', ')}`)
  }
  return {
    publicKey: requireVar(env, 'SLOPDECK_VAPID_PUBLIC_KEY'),
    privateKey: requireVar(env, 'SLOPDECK_VAPID_PRIVATE_KEY'),
    subject: requireVar(env, 'SLOPDECK_VAPID_SUBJECT'),
  }
}

export function loadConfigFromEnv(env: Record<string, string | undefined>): GatewayConfig {
  const hookToken = requireVar(env, 'SLOPDECK_HOOK_TOKEN')
  const deckToken = requireVar(env, 'SLOPDECK_DECK_TOKEN')
  if (hookToken === deckToken) {
    throw new Error('SLOPDECK_HOOK_TOKEN and SLOPDECK_DECK_TOKEN are identical — scopes must use distinct tokens')
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
    alertThresholdMs: loadMillisVar(env, 'SLOPDECK_ALERT_THRESHOLD_MS', DEFAULT_ALERT_THRESHOLD_MS),
    questionTimeoutMs: loadMillisVar(env, 'SLOPDECK_QUESTION_TIMEOUT_MS', DEFAULT_QUESTION_TIMEOUT_MS),
    vapid: loadVapid(env),
  }
}
