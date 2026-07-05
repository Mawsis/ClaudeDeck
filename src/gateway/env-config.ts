import { DEFAULT_ALERT_THRESHOLD_MS } from '../pwa/deck-reducer.js'
import { DEFAULT_QUESTION_TIMEOUT_MS } from './question-routes.ts'

export type VapidConfig = {
  readonly publicKey: string
  readonly privateKey: string
  readonly subject: string
}

export type HostedMintConfig = {
  readonly rateLimit: { readonly max: number; readonly windowMs: number }
  /** Inactivity window after which an unclaimed anonymous workspace is swept. */
  readonly ephemeralTtlMs: number
}

export type GatewayConfig = {
  /**
   * Legacy static tokens. Absent → a mint-only gateway that seeds no compat
   * workspace; present (both) → seeded as one implicit workspace's hook/deck
   * keys for backward compatibility.
   */
  readonly hookToken: string | undefined
  readonly deckToken: string | undefined
  readonly port: number
  readonly alertThresholdMs: number
  readonly questionTimeoutMs: number
  /** Absent → Web Push disabled; in-page alerts are unaffected. */
  readonly vapid: VapidConfig | undefined
  /** Absent → hosted (public) mint disabled; only local mint and any seeded workspace. */
  readonly hostedMint: HostedMintConfig | undefined
  /** The ungated `/api/mint/local` route; off unless the local install opts in. */
  readonly localMint: boolean
}

const DEFAULT_MINT_RATE_MAX = 10
const DEFAULT_MINT_RATE_WINDOW_MS = 60_000
const DEFAULT_EPHEMERAL_TTL_MS = 7 * 24 * 60 * 60 * 1000

/** Present hosted-mint config only when explicitly opted in; else undefined. */
function loadHostedMint(env: Record<string, string | undefined>): HostedMintConfig | undefined {
  const flag = env.SLOPDECK_HOSTED_MINT
  if (flag === undefined || flag === '' || flag === '0') return undefined
  return {
    rateLimit: {
      max: loadMillisVar(env, 'SLOPDECK_MINT_RATE_MAX', DEFAULT_MINT_RATE_MAX),
      windowMs: loadMillisVar(env, 'SLOPDECK_MINT_RATE_WINDOW_MS', DEFAULT_MINT_RATE_WINDOW_MS),
    },
    ephemeralTtlMs: loadMillisVar(env, 'SLOPDECK_EPHEMERAL_TTL_MS', DEFAULT_EPHEMERAL_TTL_MS),
  }
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
  // The two static tokens are now optional and all-or-nothing: both present
  // seed the backward-compat workspace; both absent is the normal mint-only
  // hosted case; exactly one is a misconfiguration (a lone token can't form the
  // hook+deck pair a workspace needs).
  const rawHook = env.SLOPDECK_HOOK_TOKEN
  const rawDeck = env.SLOPDECK_DECK_TOKEN
  const hasHook = rawHook !== undefined && rawHook !== ''
  const hasDeck = rawDeck !== undefined && rawDeck !== ''
  if (hasHook !== hasDeck) {
    throw new Error(
      `set both SLOPDECK_HOOK_TOKEN and SLOPDECK_DECK_TOKEN or neither — missing ${
        hasHook ? 'SLOPDECK_DECK_TOKEN' : 'SLOPDECK_HOOK_TOKEN'
      }`,
    )
  }
  const hookToken = hasHook ? rawHook : undefined
  const deckToken = hasDeck ? rawDeck : undefined
  if (hookToken !== undefined && hookToken === deckToken) {
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
    hostedMint: loadHostedMint(env),
    localMint: env.SLOPDECK_LOCAL_MINT === '1' || env.SLOPDECK_LOCAL_MINT === 'true',
  }
}
