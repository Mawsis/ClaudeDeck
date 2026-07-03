import { basename } from 'node:path'
import { Hono } from 'hono'
import { streamSSE } from 'hono/streaming'
import { requireScope, type AuthTokens } from './auth.ts'
import type { EventLog } from './event-log.ts'
import { loadPwaHtml } from './static.ts'

export type AppConfig = AuthTokens & {
  readonly eventLog: EventLog
  readonly maxStreamClients?: number
}

const DEFAULT_MAX_STREAM_CLIENTS = 8
const MAX_TITLE_LENGTH = 120

type StopHookPayload = {
  readonly hook_event_name: 'Stop'
  readonly session_id: string
  readonly cwd: string
}

function parseStopPayload(body: unknown): StopHookPayload | undefined {
  if (typeof body !== 'object' || body === null) return undefined
  const record = body as Record<string, unknown>
  if (record.hook_event_name !== 'Stop') return undefined
  if (typeof record.session_id !== 'string' || record.session_id === '') return undefined
  if (typeof record.cwd !== 'string' || record.cwd === '') return undefined
  return { hook_event_name: 'Stop', session_id: record.session_id, cwd: record.cwd }
}

export function createApp(config: AppConfig) {
  const { eventLog, hookToken, deckToken } = config
  const tokens: AuthTokens = { hookToken, deckToken }
  const pwaHtml = loadPwaHtml()
  const app = new Hono()

  app.get('/', (c) => c.html(pwaHtml))

  app.post('/api/events', requireScope('hook', tokens), async (c) => {
    let body: unknown
    try {
      body = await c.req.json()
    } catch {
      return c.json({ error: 'body must be JSON' }, 400)
    }

    const payload = parseStopPayload(body)
    if (payload === undefined) {
      return c.json({ error: 'expected a Stop hook payload with session_id and cwd' }, 400)
    }

    const event = eventLog.publish({
      type: 'stop',
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
        const unsubscribe = eventLog.subscribe((event) => {
          void stream.writeSSE({
            id: String(event.id),
            event: event.type,
            data: JSON.stringify(event),
          })
        })
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
