import { basename } from 'node:path'
import type { Hono } from 'hono'
import { requireScope, type AuthTokens } from './auth.ts'
import type { EventLog } from './event-log.ts'
import { createPendingPromptStore } from './pending-prompts.ts'
import type { PushRegistry } from './push-registry.ts'
import { clampDetail, permissionDetail } from './tool-detail.ts'

const MAX_TITLE_LENGTH = 120

type PermissionPayload = {
  readonly session_id: string
  readonly cwd: string
  readonly tool_name: string
  readonly tool_input: unknown
}

function parsePermissionPayload(body: unknown): PermissionPayload | undefined {
  if (typeof body !== 'object' || body === null) return undefined
  const record = body as Record<string, unknown>
  if (record.hook_event_name !== 'PermissionRequest') return undefined
  if (typeof record.session_id !== 'string' || record.session_id === '') return undefined
  if (typeof record.cwd !== 'string' || record.cwd === '') return undefined
  if (typeof record.tool_name !== 'string' || record.tool_name === '') return undefined
  return {
    session_id: record.session_id,
    cwd: record.cwd,
    tool_name: record.tool_name,
    tool_input: record.tool_input,
  }
}

const RESOLUTION_ACTIONS = ['allow', 'deny', 'ask'] as const
type ResolutionAction = (typeof RESOLUTION_ACTIONS)[number]

function parseResolutionAction(body: unknown): ResolutionAction | undefined {
  if (typeof body !== 'object' || body === null) return undefined
  const action = (body as Record<string, unknown>).action
  return RESOLUTION_ACTIONS.find((known) => known === action)
}

export type PermissionRoutesConfig = {
  readonly tokens: AuthTokens
  readonly eventLog: EventLog
  readonly pushRegistry?: PushRegistry | undefined
  readonly hasDeck: () => boolean
  /** Test seam only — production uses the 540s D4 default. */
  readonly timeoutMs?: number | undefined
}

/**
 * The permission gate (D3/D4): a PermissionRequest http hook is held open
 * while the deck decides, then answered with the documented decision JSON —
 * or with `{}` (no decision, the terminal dialog proceeds) for Ask-in-terminal
 * and every fallback. Never auto-deny.
 */
export function registerPermissionRoutes(app: Hono, config: PermissionRoutesConfig): void {
  const { tokens, eventLog, pushRegistry } = config

  const promptStore = createPendingPromptStore({
    hasDeck: config.hasDeck,
    ...(config.timeoutMs !== undefined ? { timeoutMs: config.timeoutMs } : {}),
  })

  app.post('/api/permission', requireScope('hook', tokens), async (c) => {
    let body: unknown
    try {
      body = await c.req.json()
    } catch {
      return c.json({ error: 'body must be JSON' }, 400)
    }

    const payload = parsePermissionPayload(body)
    if (payload === undefined) {
      return c.json(
        { error: 'expected a PermissionRequest hook payload with session_id, cwd, and tool_name' },
        400,
      )
    }

    const held = promptStore.hold()
    const base = {
      sessionId: payload.session_id,
      title: basename(payload.cwd).slice(0, MAX_TITLE_LENGTH),
      cwd: payload.cwd,
      promptId: held.id,
    }
    const detail = permissionDetail(payload.tool_input, payload.cwd)
    eventLog.publish({ type: 'permission', ...base, tool: payload.tool_name, detail })

    // D11: pending prompts always alert — they block a session. A prompt the
    // no-deck fallback already answered was never pending; alerting for a
    // card that doesn't exist would be a lie. The service worker drops the
    // push when a deck window is visible (the takeover is the alert there).
    // The full payload lives on the approval card; the push only says "come
    // look" and must stay under the ~4KB Web Push payload cap.
    if (held.pending) {
      pushRegistry?.broadcast(
        JSON.stringify({
          kind: 'permission',
          title: base.title,
          tool: payload.tool_name,
          detail: clampDetail(detail),
        }),
      )
    }

    const decision = await held.decision
    eventLog.publish({
      type: 'permission-resolved',
      ...base,
      outcome: decision?.behavior ?? 'ask',
    })
    if (decision === null) return c.json({}, 200)
    return c.json({ hookSpecificOutput: { hookEventName: 'PermissionRequest', decision } }, 200)
  })

  app.post('/api/prompts/:id/resolution', requireScope('deck', tokens), async (c) => {
    let body: unknown
    try {
      body = await c.req.json()
    } catch {
      return c.json({ error: 'body must be JSON' }, 400)
    }

    const action = parseResolutionAction(body)
    if (action === undefined) {
      return c.json({ error: 'expected { action: "allow" | "deny" | "ask" }' }, 400)
    }

    // Ask-in-terminal is a real answer whose content is "no decision" —
    // the terminal dialog proceeds (D3).
    const decision = action === 'ask' ? null : { behavior: action }
    if (!promptStore.resolve(c.req.param('id'), decision)) {
      return c.json({ error: 'unknown or already resolved prompt' }, 404)
    }
    return c.json({ ok: true }, 200)
  })
}
