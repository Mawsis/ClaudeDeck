import type { BashCategory, BashRisk } from './bash-classifier.ts'

export type DeckEventType = 'prompt' | 'stop' | 'tool'

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

export type DeckEventInput = LifecycleEventInput | ToolEventInput

export type DeckEvent = DeckEventInput & {
  readonly id: number
  /** Server publish time (epoch ms) — replayed events must not inherit receipt time. */
  readonly at: number
}
