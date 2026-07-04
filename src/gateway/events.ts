import type { BashCategory, BashRisk } from './bash-classifier.ts'

export type DeckEventType =
  | 'prompt'
  | 'stop'
  | 'tool'
  | 'permission'
  | 'permission-resolved'
  | 'question'
  | 'question-resolved'
  | 'mode'

export type TickerCategory = BashCategory | 'edit'

export type LifecycleEventInput = {
  readonly type: 'prompt' | 'stop'
  readonly sessionId: string
  readonly title: string
  readonly cwd: string
}

/** A completed high-impact tool call — one row on the deck's ticker. */
export type ToolEventInput = {
  readonly type: 'tool'
  readonly sessionId: string
  readonly title: string
  readonly cwd: string
  readonly tool: string
  readonly detail: string
  readonly category: TickerCategory
  readonly risk: BashRisk
}

/** D15 collapsed to what the card needs: only classifier-`high` commands
 * stretch the Allow hold — the ticker's `highlighted` tier keeps the
 * standard one, so it arrives here as `routine`. */
export type PermissionRisk = 'high' | 'routine'

/** A held permission dialog awaiting the deck's answer — the approval card. */
export type PermissionEventInput = {
  readonly type: 'permission'
  readonly sessionId: string
  readonly title: string
  readonly cwd: string
  readonly promptId: string
  readonly tool: string
  readonly detail: string
  readonly risk: PermissionRisk
}

/** How a held prompt settled; `ask` covers every no-decision path (tap,
 * silence fallback, no-deck fallback) — the terminal dialog took over. */
export type PermissionOutcome = 'allow' | 'deny' | 'ask'

export type PermissionResolvedEventInput = {
  readonly type: 'permission-resolved'
  readonly sessionId: string
  readonly title: string
  readonly cwd: string
  readonly promptId: string
  readonly outcome: PermissionOutcome
}

/** A held AskUserQuestion awaiting the deck's tap — one card, tappable
 * choices (D3's flagged hack). */
export type QuestionEventInput = {
  readonly type: 'question'
  readonly sessionId: string
  readonly title: string
  readonly cwd: string
  readonly promptId: string
  readonly question: string
  readonly options: readonly string[]
}

/** How a held question settled; `ask` covers every no-answer path (timeout,
 * no-deck, pause, explicit ask-in-terminal) — the terminal re-asks. */
export type QuestionOutcome = 'answered' | 'ask'

export type QuestionResolvedEventInput = {
  readonly type: 'question-resolved'
  readonly sessionId: string
  readonly title: string
  readonly cwd: string
  readonly promptId: string
  readonly outcome: QuestionOutcome
}

/** D5: the gateway's interception mode, broadcast so a reconnecting deck
 * reloads with the right accent. Global — it carries no session. */
export type ModeEventInput = {
  readonly type: 'mode'
  readonly paused: boolean
}

export type DeckEventInput =
  | LifecycleEventInput
  | ToolEventInput
  | PermissionEventInput
  | PermissionResolvedEventInput
  | QuestionEventInput
  | QuestionResolvedEventInput
  | ModeEventInput

export type DeckEvent = DeckEventInput & {
  readonly id: number
  /** Server publish time (epoch ms) — replayed events must not inherit receipt time. */
  readonly at: number
}
