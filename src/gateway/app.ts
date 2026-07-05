import { basename } from 'node:path'
import { Hono } from 'hono'
import { streamSSE } from 'hono/streaming'
import { completionAlert, DEFAULT_ALERT_THRESHOLD_MS, initialDeckState, reduceDeck } from '../pwa/deck-reducer.js'
import { requireScope, type AuthTokens } from './auth.ts'
import { classifyBash } from './bash-classifier.ts'
import type { EventLog } from './event-log.ts'
import type { DeckEvent } from './events.ts'
import { createPauseState } from './pause-state.ts'
import { registerPermissionRoutes } from './permission-routes.ts'
import { registerQuestionRoutes } from './question-routes.ts'
import { createPushRegistry, type PushSender, type PushSubscriptionJson } from './push-registry.ts'
import { loadBrandAssets, loadDeckReducerJs, loadPwaHtml, loadServiceWorkerJs } from './static.ts'
import { clampDetail, extractToolDetail } from './tool-detail.ts'

export type { PushSender, PushSubscriptionJson } from './push-registry.ts'

export type AlertsConfig = {
  readonly thresholdMs?: number
  readonly vapidPublicKey?: string
  /** Absent → Web Push disabled; the deck's in-page alerts are unaffected. */
  readonly sendPush?: PushSender
}

export type AppConfig = AuthTokens & {
  readonly eventLog: EventLog
  readonly maxStreamClients?: number
  readonly now?: () => number
  readonly alerts?: AlertsConfig
  /** Test seam only — production uses the 540s D4 default. */
  readonly permissionTimeoutMs?: number
  /** Question hold window; defaults to 60s, separate from the 540s permission policy. */
  readonly questionTimeoutMs?: number
}

const DEFAULT_MAX_STREAM_CLIENTS = 8
const MAX_TITLE_LENGTH = 120

const HOOK_EVENT_TYPES = {
  Stop: 'stop',
  UserPromptSubmit: 'prompt',
  // Not a real Claude Code hook: the CLI install fires this one itself as the
  // proof-of-pipeline ping, through the same authenticated ingest path.
  Handshake: 'handshake',
} as const

type HookPayload =
  | {
      readonly type: (typeof HOOK_EVENT_TYPES)[keyof typeof HOOK_EVENT_TYPES]
      readonly session_id: string
      readonly cwd: string
    }
  | {
      readonly type: 'tool'
      readonly session_id: string
      readonly cwd: string
      readonly tool_name: string
      readonly detail: string
    }

/** A missing or malformed header replays nothing — Infinity is "after everything". */
function parseLastEventId(header: string | undefined): number {
  if (header === undefined || header.trim() === '') return Infinity
  const id = Number(header)
  return Number.isSafeInteger(id) && id >= 0 ? id : Infinity
}

/** Push service endpoints are always https; anything else is an SSRF target. */
function isHttpsUrl(value: string): boolean {
  try {
    return new URL(value).protocol === 'https:'
  } catch {
    return false
  }
}

function parsePushSubscription(body: unknown): PushSubscriptionJson | undefined {
  if (typeof body !== 'object' || body === null) return undefined
  const record = body as Record<string, unknown>
  if (typeof record.endpoint !== 'string' || !isHttpsUrl(record.endpoint)) return undefined
  if (typeof record.keys !== 'object' || record.keys === null) return undefined
  const keys = record.keys as Record<string, unknown>
  if (typeof keys.p256dh !== 'string' || keys.p256dh === '') return undefined
  if (typeof keys.auth !== 'string' || keys.auth === '') return undefined
  // Browsers attach extras (expirationTime); only what web-push needs is kept.
  return { endpoint: record.endpoint, keys: { p256dh: keys.p256dh, auth: keys.auth } }
}

function parseHookPayload(body: unknown): HookPayload | undefined {
  if (typeof body !== 'object' || body === null) return undefined
  const record = body as Record<string, unknown>
  if (typeof record.session_id !== 'string' || record.session_id === '') return undefined
  if (typeof record.cwd !== 'string' || record.cwd === '') return undefined
  const common = { session_id: record.session_id, cwd: record.cwd }

  if (record.hook_event_name === 'PostToolUse') {
    if (typeof record.tool_name !== 'string' || record.tool_name === '') return undefined
    return {
      type: 'tool',
      ...common,
      tool_name: record.tool_name,
      detail: extractToolDetail(record.tool_input, record.cwd),
    }
  }

  const type = HOOK_EVENT_TYPES[record.hook_event_name as keyof typeof HOOK_EVENT_TYPES]
  if (type === undefined) return undefined
  return { type, ...common }
}

export function createApp(config: AppConfig) {
  const { eventLog, hookToken, deckToken } = config
  const now = config.now ?? Date.now
  // Event ids restart at 1 with the process; the bootId is what lets a deck
  // that stayed open across a gateway restart tell a colliding fresh id from
  // a duplicate delivery of an old one.
  const bootId = crypto.randomUUID()
  const tokens: AuthTokens = { hookToken, deckToken }
  const pwaHtml = loadPwaHtml()
  const deckReducerJs = loadDeckReducerJs()
  const serviceWorkerJs = loadServiceWorkerJs()
  const brandAssets = loadBrandAssets()
  const app = new Hono()

  const alertThresholdMs = config.alerts?.thresholdMs ?? DEFAULT_ALERT_THRESHOLD_MS
  const sendPush = config.alerts?.sendPush
  const pushRegistry = sendPush === undefined ? undefined : createPushRegistry(sendPush)

  // D5: the deck's one-tap Pause flips interception off; while paused, a held
  // prompt falls back instantly to the terminal instead of rendering a card.
  const pauseState = createPauseState()

  // The gateway mirrors the deck's state through the same pure reducer; when
  // the deck is dark, this is where the alert decision still gets made.
  let deckState = initialDeckState
  eventLog.subscribe((event) => {
    if (event.type !== 'prompt' && event.type !== 'stop') return
    const alert = completionAlert(deckState, event, { thresholdMs: alertThresholdMs })
    deckState = reduceDeck(deckState, event)
    if (alert === null || pushRegistry === undefined) return
    pushRegistry.broadcast(JSON.stringify({ title: alert.title, elapsedMs: alert.elapsedMs }))
  })

  // The app shell and its ES modules ARE the versioned code — a stale copy
  // renders an old deck against a new gateway (e.g. a question card that can't
  // read the current event shape). Serve them no-cache so the browser always
  // revalidates: a redeploy takes effect on the next load, not hours later.
  const NO_CACHE = 'no-cache'

  app.get('/', (c) => {
    c.header('Cache-Control', NO_CACHE)
    return c.html(pwaHtml)
  })

  app.get('/deck-reducer.js', (c) =>
    c.body(deckReducerJs, 200, {
      'Content-Type': 'text/javascript; charset=utf-8',
      'Cache-Control': NO_CACHE,
    }),
  )

  // Brand assets are a startup-loaded whitelist — a miss is a 404, and the
  // request path never touches the filesystem. These are content-stable, so a
  // long cache is fine (a rebrand swaps the files and bumps the deploy).
  app.get('/brand/:name', (c) => {
    const asset = brandAssets.get(c.req.param('name'))
    if (asset === undefined) return c.notFound()
    return c.body(asset, 200, {
      'Content-Type': 'image/svg+xml',
      'Cache-Control': 'max-age=86400',
    })
  })

  app.get('/sw.js', (c) =>
    c.body(serviceWorkerJs, 200, {
      'Content-Type': 'text/javascript; charset=utf-8',
      'Cache-Control': NO_CACHE,
    }),
  )

  app.post('/api/events', requireScope('hook', tokens), async (c) => {
    let body: unknown
    try {
      body = await c.req.json()
    } catch {
      return c.json({ error: 'body must be JSON' }, 400)
    }

    const payload = parseHookPayload(body)
    if (payload === undefined) {
      return c.json(
        {
          error:
            'expected a Stop, UserPromptSubmit, PostToolUse, or Handshake hook payload with session_id and cwd',
        },
        400,
      )
    }

    const base = {
      sessionId: payload.session_id,
      title: basename(payload.cwd).slice(0, MAX_TITLE_LENGTH),
      cwd: payload.cwd,
    }
    const event =
      payload.type === 'tool'
        ? eventLog.publish({
            type: 'tool',
            ...base,
            tool: payload.tool_name,
            detail: clampDetail(payload.detail),
            // Classification is command-driven for Bash; every other tool the
            // matcher registers is a file edit — a routine, dim ticker row.
            ...(payload.tool_name === 'Bash'
              ? classifyBash(payload.detail)
              : { category: 'edit' as const, risk: 'routine' as const }),
          })
        : eventLog.publish({ type: payload.type, ...base })
    return c.json({ id: event.id }, 202)
  })

  app.get('/api/deck-config', requireScope('deck', tokens), (c) =>
    c.json({
      alertThresholdMs,
      vapidPublicKey: config.alerts?.vapidPublicKey ?? null,
      // A hard reload starts from initialDeckState (unpaused) and gets no SSE
      // replay without a Last-Event-ID; deck-config is where it learns the mode.
      paused: pauseState.isPaused(),
    }),
  )

  app.post('/api/push/subscriptions', requireScope('deck', tokens), async (c) => {
    let body: unknown
    try {
      body = await c.req.json()
    } catch {
      return c.json({ error: 'body must be JSON' }, 400)
    }

    const subscription = parsePushSubscription(body)
    if (subscription === undefined) {
      return c.json(
        { error: 'expected a Web Push subscription with endpoint and keys.p256dh/keys.auth' },
        400,
      )
    }

    // The deck re-registers on every connect — registration is idempotent.
    pushRegistry?.register(subscription)
    return c.json({ ok: true }, 201)
  })

  const maxStreamClients = config.maxStreamClients ?? DEFAULT_MAX_STREAM_CLIENTS
  // Oldest-first so exceeding the cap evicts stale/dead connections rather
  // than locking out a reconnecting deck.
  const activeStreamClosers: Array<() => void> = []

  // D3/D4/D5: a permission prompt is held only while a deck stream is open to
  // render it and interception is on — otherwise holding just delays the
  // terminal dialog.
  registerPermissionRoutes(app, {
    tokens,
    eventLog,
    pushRegistry,
    hasDeck: () => activeStreamClosers.length > 0,
    isPaused: () => pauseState.isPaused(),
    timeoutMs: config.permissionTimeoutMs,
  })

  // The AskUserQuestion hack shares the permission gate's fallback policy
  // (D3/D4) but not its timeout — questions hold for 60s, not 540s. The route
  // always exists — the opt-in feature flag lives in the generated hook
  // config, so an un-flagged workstation simply never calls it.
  registerQuestionRoutes(app, {
    tokens,
    eventLog,
    hasDeck: () => activeStreamClosers.length > 0,
    isPaused: () => pauseState.isPaused(),
    timeoutMs: config.questionTimeoutMs,
  })

  // The CLI's install flow verifies a pasted hook token live, before writing
  // any file — an authenticated no-op behind the same scope gate as ingest.
  app.get('/api/hook-check', requireScope('hook', tokens), (c) => c.json({ ok: true }, 200))

  // A tap toggles interception and broadcasts the new mode through the log, so
  // it streams live and replays to any deck that reconnects (D5/D14). An
  // explicit `{ paused }` body sets instead of flipping — idempotent, for the
  // CLI's on/off remote; the deck's bare-body tap keeps its toggle.
  app.post('/api/pause', requireScope('deck', tokens), async (c) => {
    let requested: unknown
    try {
      requested = ((await c.req.json()) as Record<string, unknown>).paused
    } catch {
      requested = undefined
    }
    const paused =
      typeof requested === 'boolean' ? pauseState.set(requested) : pauseState.toggle()
    eventLog.publish({ type: 'mode', paused })
    return c.json({ paused }, 200)
  })

  app.get('/api/stream', requireScope('deck', tokens), (c) =>
    streamSSE(
      c,
      async (stream) => {
        let finish!: () => void
        const closed = new Promise<void>((resolve) => {
          finish = resolve
        })
        // serverNow lets the client turn (serverNow - at) into a clock-skew-free
        // event age: replayed frames carry their true age, live frames age 0.
        const writeEvent = (event: DeckEvent) =>
          void stream.writeSSE({
            id: String(event.id),
            event: event.type,
            data: JSON.stringify({ ...event, serverNow: now(), bootId }),
          })
        // Snapshot the missed events and subscribe in the same synchronous
        // block: publish() is synchronous, so nothing can slip between them.
        const missed = eventLog.since(parseLastEventId(c.req.header('Last-Event-ID')))
        const unsubscribe = eventLog.subscribe(writeEvent)
        for (const event of missed) {
          writeEvent(event)
        }
        const close = () => {
          unsubscribe()
          finish()
        }

        activeStreamClosers.push(close)
        while (activeStreamClosers.length > maxStreamClients) {
          activeStreamClosers.shift()!()
        }
        stream.onAbort(() => {
          const index = activeStreamClosers.indexOf(close)
          if (index !== -1) activeStreamClosers.splice(index, 1)
          close()
        })

        await closed
      },
      async (error) => {
        console.error('sse stream error:', error)
      },
    ),
  )

  return app
}
