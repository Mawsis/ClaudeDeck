import { basename } from 'node:path'
import { Hono } from 'hono'
import { streamSSE } from 'hono/streaming'
import { DEFAULT_ALERT_THRESHOLD_MS } from '../pwa/deck-reducer.js'
import { requireAnyKey, requireWorkspace, type WorkspaceVariables } from './auth.ts'
import { classifyBash } from './bash-classifier.ts'
import type { DeckEvent } from './events.ts'
import { registerMintRoutes, type MintConfig } from './mint-routes.ts'
import { registerPermissionRoutes } from './permission-routes.ts'
import { DEFAULT_QUESTION_TIMEOUT_MS, registerQuestionRoutes } from './question-routes.ts'
import { createPushRegistry, type PushSender, type PushSubscriptionJson } from './push-registry.ts'
import { loadBrandAssets, loadDeckReducerJs, loadPwaHtml, loadServiceWorkerJs } from './static.ts'
import { clampDetail, extractToolDetail } from './tool-detail.ts'
import { createWorkspaceRuntime, type WorkspaceRuntime } from './workspace-runtime.ts'
import type { WorkspaceStore } from './workspace-store.ts'

export type { PushSender, PushSubscriptionJson } from './push-registry.ts'

/** Every route is workspace-scoped: auth stashes the resolved id, handlers read it. */
export type AppEnv = { Variables: WorkspaceVariables }

/** How a handler reaches the caller's isolated state — lazily built, cached by id. */
export type RuntimeFor = (workspaceId: string) => WorkspaceRuntime

export type AlertsConfig = {
  readonly thresholdMs?: number
  readonly vapidPublicKey?: string
  /** Absent → Web Push disabled; the deck's in-page alerts are unaffected. */
  readonly sendPush?: PushSender
}

export type AppConfig = {
  /** The identity/isolation store — resolves keys to workspaces and mints them. */
  readonly workspaceStore: WorkspaceStore
  readonly maxStreamClients?: number
  readonly now?: () => number
  readonly alerts?: AlertsConfig
  /** Test seam only — production uses the 540s D4 default. */
  readonly permissionTimeoutMs?: number
  /** Question hold window; defaults to 60s, separate from the 540s permission policy. */
  readonly questionTimeoutMs?: number
  /** Mint endpoints; absent hosted rate-limit disables the hosted endpoint. */
  readonly mint?: MintConfig
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
  const { workspaceStore } = config
  const now = config.now ?? Date.now
  // Event ids restart at 1 with the process; the bootId is what lets a deck
  // that stayed open across a gateway restart tell a colliding fresh id from
  // a duplicate delivery of an old one. Process-global by design: it identifies
  // the gateway boot, not the workspace.
  const bootId = crypto.randomUUID()
  const pwaHtml = loadPwaHtml()
  const deckReducerJs = loadDeckReducerJs()
  const serviceWorkerJs = loadServiceWorkerJs()
  const brandAssets = loadBrandAssets()
  const app = new Hono<AppEnv>()

  const alertThresholdMs = config.alerts?.thresholdMs ?? DEFAULT_ALERT_THRESHOLD_MS
  const questionTimeoutMs = config.questionTimeoutMs ?? DEFAULT_QUESTION_TIMEOUT_MS
  const sendPush = config.alerts?.sendPush
  const pushRegistry = sendPush === undefined ? undefined : createPushRegistry(sendPush)

  // The isolation registry: one runtime per workspace, built on first touch and
  // cached. Each runtime owns its event ring buffer, pause bit, held-prompt
  // stores, and deck list — nothing here is shared across the boundary, so a
  // handler that reads `runtimeFor(c.get('workspaceId'))` can only ever see the
  // caller's own state. This is the structural guarantee behind isolation.
  const runtimes = new Map<string, WorkspaceRuntime>()
  const runtimeFor: RuntimeFor = (workspaceId) => {
    let runtime = runtimes.get(workspaceId)
    if (runtime === undefined) {
      runtime = createWorkspaceRuntime({
        ...(config.now ? { now: config.now } : {}),
        alertThresholdMs,
        ...(config.permissionTimeoutMs !== undefined
          ? { permissionTimeoutMs: config.permissionTimeoutMs }
          : {}),
        questionTimeoutMs,
        pushRegistry,
      })
      runtimes.set(workspaceId, runtime)
    }
    return runtime
  }

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

  app.post('/api/events', requireWorkspace('hook', workspaceStore), async (c) => {
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

    // The hook key resolved to exactly one workspace; its event lands only in
    // that workspace's ring buffer and reaches only that workspace's decks.
    const { eventLog } = runtimeFor(c.get('workspaceId'))
    workspaceStore.touch(c.get('workspaceId'))
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

  app.get('/api/deck-config', requireWorkspace('deck', workspaceStore), (c) =>
    c.json({
      alertThresholdMs,
      vapidPublicKey: config.alerts?.vapidPublicKey ?? null,
      // A hard reload starts from initialDeckState (unpaused) and gets no SSE
      // replay without a Last-Event-ID; deck-config is where it learns the mode.
      paused: runtimeFor(c.get('workspaceId')).pauseState.isPaused(),
    }),
  )

  app.post('/api/push/subscriptions', requireWorkspace('deck', workspaceStore), async (c) => {
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

  // D3/D4/D5: a permission prompt is held only while a deck stream is open to
  // render it and interception is on — otherwise holding just delays the
  // terminal dialog. Per-workspace: the hold store, deck presence, and pause
  // bit all come from the caller's own runtime.
  registerPermissionRoutes(app, {
    store: workspaceStore,
    runtimeFor,
    pushRegistry,
  })

  // The AskUserQuestion hack shares the permission gate's fallback policy
  // (D3/D4) but not its timeout — questions hold for 60s, not 540s. The route
  // always exists — the opt-in feature flag lives in the generated hook
  // config, so an un-flagged workstation simply never calls it.
  registerQuestionRoutes(app, {
    store: workspaceStore,
    runtimeFor,
  })

  // Mint: local is ungated (localhost is the trust boundary); hosted is public
  // and IP-rate-limited. Both hand back a fresh workspace's keys, no token typed.
  registerMintRoutes(app, {
    store: workspaceStore,
    ...(config.mint ? { mint: config.mint } : {}),
    ...(config.now ? { now: config.now } : {}),
  })

  // The CLI's install flow verifies a pasted hook token live, before writing
  // any file — an authenticated no-op behind the same scope gate as ingest.
  app.get('/api/hook-check', requireWorkspace('hook', workspaceStore), (c) => c.json({ ok: true }, 200))

  // Rotation: holding either current key re-inscribes the whole workspace. The
  // fresh hook+deck pair comes back once; both old keys are dead immediately,
  // so the currently-paired phone disconnects until it re-scans the new QR.
  app.post('/api/rotate', requireAnyKey(workspaceStore), (c) => {
    // requireAnyKey already resolved and stashed the workspace id, so we rotate
    // by id — the fresh hook+deck pair comes back once and both old keys die.
    return c.json(workspaceStore.rotateWorkspaceById(c.get('workspaceId')), 200)
  })

  // A tap toggles interception and broadcasts the new mode through the log, so
  // it streams live and replays to any deck that reconnects (D5/D14). An
  // explicit `{ paused }` body sets instead of flipping — idempotent, for the
  // CLI's on/off remote; the deck's bare-body tap keeps its toggle. Scoped to
  // the caller's workspace: pausing one deck never pauses another's.
  app.post('/api/pause', requireWorkspace('deck', workspaceStore), async (c) => {
    let requested: unknown
    try {
      requested = ((await c.req.json()) as Record<string, unknown>).paused
    } catch {
      requested = undefined
    }
    const { eventLog, pauseState } = runtimeFor(c.get('workspaceId'))
    const paused =
      typeof requested === 'boolean' ? pauseState.set(requested) : pauseState.toggle()
    eventLog.publish({ type: 'mode', paused })
    return c.json({ paused }, 200)
  })

  app.get('/api/stream', requireWorkspace('deck', workspaceStore), (c) => {
    const { eventLog, streamClosers } = runtimeFor(c.get('workspaceId'))
    workspaceStore.touch(c.get('workspaceId'))
    return streamSSE(
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
        // Both `since` and `subscribe` are this workspace's own log.
        const missed = eventLog.since(parseLastEventId(c.req.header('Last-Event-ID')))
        const unsubscribe = eventLog.subscribe(writeEvent)
        for (const event of missed) {
          writeEvent(event)
        }
        const close = () => {
          unsubscribe()
          finish()
        }

        streamClosers.push(close)
        while (streamClosers.length > maxStreamClients) {
          streamClosers.shift()!()
        }
        stream.onAbort(() => {
          const index = streamClosers.indexOf(close)
          if (index !== -1) streamClosers.splice(index, 1)
          close()
        })

        await closed
      },
      async (error) => {
        console.error('sse stream error:', error)
      },
    )
  })

  /**
   * Sweep expired anonymous workspaces AND evict their in-memory runtimes in
   * lockstep, so a swept workspace leaves nothing behind — its store row is
   * deleted and its EventLog/pending-stores/deck list are dropped from the
   * registry. Returns the swept workspace ids. Without this the `runtimes` Map
   * would grow unbounded as ephemeral workspaces churn.
   */
  const sweepExpired = (before: number): string[] => {
    const ids = workspaceStore.expiredIds(before)
    workspaceStore.deleteExpired(before)
    for (const id of ids) {
      const runtime = runtimes.get(id)
      // Close any lingering streams before dropping the runtime so no writer is
      // left holding a reference to a workspace that no longer exists.
      runtime?.streamClosers.splice(0).forEach((close) => close())
      runtimes.delete(id)
    }
    return ids
  }

  // `runtimeFor` is returned so a caller (server bootstrap, tests) can reach a
  // workspace's own event log directly — e.g. to seed or inspect it. Handlers
  // never need it from outside; they resolve their runtime off the context.
  return { app, runtimeFor, sweepExpired }
}
