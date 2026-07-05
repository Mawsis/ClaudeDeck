import { completionAlert, initialDeckState, reduceDeck } from '../pwa/deck-reducer.js'
import { createEventLog, type EventLog } from './event-log.ts'
import type { QuestionSpec } from './events.ts'
import { createPauseState, type PauseState } from './pause-state.ts'
import {
  createPendingPromptStore,
  type PendingPromptStore,
} from './pending-prompts.ts'
import type { PushRegistry } from './push-registry.ts'
import type { QuestionAnswer } from './question-routes.ts'

/**
 * Everything that is scoped to one workspace and MUST NOT be shared across the
 * isolation boundary: its own event ring buffer (own id sequence, own replay),
 * its own pause bit, its own held-prompt stores, and its own list of open deck
 * streams. A leak is only possible by handing one workspace another's runtime —
 * the registry never does — so isolation is a structural property, not a filter
 * that can be forgotten on some read path.
 */
export type WorkspaceRuntime = {
  readonly eventLog: EventLog
  readonly pauseState: PauseState
  readonly permStore: PendingPromptStore
  readonly questionStore: PendingPromptStore<QuestionAnswer>
  /** What each held question actually asked, for answer-set validation. */
  readonly heldQuestions: Map<string, readonly QuestionSpec[]>
  /** Open deck stream closers, oldest first; drives `hasDeck` and the client cap. */
  readonly streamClosers: Array<() => void>
  hasDeck(): boolean
}

export type WorkspaceRuntimeOptions = {
  readonly now?: () => number
  readonly alertThresholdMs: number
  readonly permissionTimeoutMs?: number
  readonly questionTimeoutMs: number
  /** Absent → no Web Push; in-page alerts are unaffected. */
  readonly pushRegistry?: PushRegistry | undefined
}

/**
 * Builds one workspace's isolated runtime. The alert-mirroring subscriber lives
 * here so each workspace's completion pushes are computed from its own deck
 * state — never another workspace's.
 */
export function createWorkspaceRuntime(options: WorkspaceRuntimeOptions): WorkspaceRuntime {
  const eventLog = createEventLog(options.now ? { now: options.now } : {})
  const pauseState = createPauseState()
  const streamClosers: Array<() => void> = []
  const hasDeck = () => streamClosers.length > 0

  const permStore = createPendingPromptStore({
    hasDeck,
    isPaused: () => pauseState.isPaused(),
    ...(options.permissionTimeoutMs !== undefined ? { timeoutMs: options.permissionTimeoutMs } : {}),
  })
  const questionStore = createPendingPromptStore<QuestionAnswer>({
    hasDeck,
    isPaused: () => pauseState.isPaused(),
    timeoutMs: options.questionTimeoutMs,
  })

  // The gateway mirrors this workspace's deck state through the same pure
  // reducer so a completion alert still fires when the deck is dark — computed
  // from THIS workspace's state alone.
  const pushRegistry = options.pushRegistry
  if (pushRegistry !== undefined) {
    let deckState = initialDeckState
    eventLog.subscribe((event) => {
      if (event.type !== 'prompt' && event.type !== 'stop') return
      const alert = completionAlert(deckState, event, { thresholdMs: options.alertThresholdMs })
      deckState = reduceDeck(deckState, event)
      if (alert === null) return
      pushRegistry.broadcast(JSON.stringify({ title: alert.title, elapsedMs: alert.elapsedMs }))
    })
  }

  return {
    eventLog,
    pauseState,
    permStore,
    questionStore,
    heldQuestions: new Map(),
    streamClosers,
    hasDeck,
  }
}
