export type DeckEventInput = {
  readonly type: 'stop'
  readonly sessionId: string
  readonly title: string
  readonly cwd: string
}

export type DeckEvent = DeckEventInput & {
  readonly id: number
}
