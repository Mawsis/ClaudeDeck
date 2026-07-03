export type DeckEventType = 'prompt' | 'stop'

export type DeckEventInput = {
  readonly type: DeckEventType
  readonly sessionId: string
  readonly title: string
  readonly cwd: string
}

export type DeckEvent = DeckEventInput & {
  readonly id: number
  /** Server publish time (epoch ms) — replayed events must not inherit receipt time. */
  readonly at: number
}
