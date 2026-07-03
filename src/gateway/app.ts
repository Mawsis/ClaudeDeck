import { basename } from 'node:path'
import { Hono } from 'hono'
import { requireScope, type AuthTokens } from './auth.ts'
import type { EventLog } from './event-log.ts'

export type AppConfig = AuthTokens & {
  readonly eventLog: EventLog
}

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
  const app = new Hono()

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
      title: basename(payload.cwd),
      cwd: payload.cwd,
    })
    return c.json({ id: event.id }, 202)
  })

  return app
}
