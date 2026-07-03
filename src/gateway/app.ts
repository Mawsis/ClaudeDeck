import { basename } from 'node:path'
import { Hono } from 'hono'
import { streamSSE } from 'hono/streaming'
import { requireScope, type AuthTokens } from './auth.ts'
import type { EventLog } from './event-log.ts'
import type { DeckEvent } from './events.ts'
import { loadDeckReducerJs, loadPwaHtml } from './static.ts'

export type AppConfig = AuthTokens & {
  readonly eventLog: EventLog
  readonly maxStreamClients?: number
  readonly now?: () => number
}

const DEFAULT_MAX_STREAM_CLIENTS = 8
const MAX_TITLE_LENGTH = 120

const HOOK_EVENT_TYPES = {
  Stop: 'stop',
  UserPromptSubmit: 'prompt',
} as const

type HookPayload = {
  readonly type: (typeof HOOK_EVENT_TYPES)[keyof typeof HOOK_EVENT_TYPES]
  readonly session_id: string
  readonly cwd: string
}

/** A missing or malformed header replays nothing — Infinity is "after everything". */
function parseLastEventId(header: string | undefined): number {
  if (header === undefined || header.trim() === '') return Infinity
  const id = Number(header)
  return Number.isSafeInteger(id) && id >= 0 ? id : Infinity
}

function parseHookPayload(body: unknown): HookPayload | undefined {
  if (typeof body !== 'object' || body === null) return undefined
  const record = body as Record<string, unknown>
  const type = HOOK_EVENT_TYPES[record.hook_event_name as keyof typeof HOOK_EVENT_TYPES]
  if (type === undefined) return undefined
  if (typeof record.session_id !== 'string' || record.session_id === '') return undefined
  if (typeof record.cwd !== 'string' || record.cwd === '') return undefined
  return { type, session_id: record.session_id, cwd: record.cwd }
}

export function createApp(config: AppConfig) {
  const { eventLog, hookToken, deckToken } = config
  const now = config.now ?? Date.now
  const tokens: AuthTokens = { hookToken, deckToken }
  const pwaHtml = loadPwaHtml()
  const deckReducerJs = loadDeckReducerJs()
  const app = new Hono()

  app.get('/', (c) => c.html(pwaHtml))

  app.get('/deck-reducer.js', (c) =>
    c.body(deckReducerJs, 200, { 'Content-Type': 'text/javascript; charset=utf-8' }),
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
        { error: 'expected a Stop or UserPromptSubmit hook payload with session_id and cwd' },
        400,
      )
    }

    const event = eventLog.publish({
      type: payload.type,
      sessionId: payload.session_id,
      title: basename(payload.cwd).slice(0, MAX_TITLE_LENGTH),
      cwd: payload.cwd,
    })
    return c.json({ id: event.id }, 202)
  })

  const maxStreamClients = config.maxStreamClients ?? DEFAULT_MAX_STREAM_CLIENTS
  // Oldest-first so exceeding the cap evicts stale/dead connections rather
  // than locking out a reconnecting deck.
  const activeStreamClosers: Array<() => void> = []

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
            data: JSON.stringify({ ...event, serverNow: now() }),
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
