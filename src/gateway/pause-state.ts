/**
 * D5: interception mode. The gateway always intercepts while a deck is
 * connected; the deck's one-tap Pause flips it to passthrough, where every
 * permission dialog falls back to the terminal instantly (no hold, no card).
 * A single mutable bit, deck-scoped and process-global — no arming ritual,
 * no presence heuristics.
 */
export type PauseState = {
  isPaused(): boolean
  /** Flip the mode; returns the resulting paused state for the deck to render. */
  toggle(): boolean
}

export function createPauseState(): PauseState {
  let paused = false

  return {
    isPaused: () => paused,
    toggle() {
      paused = !paused
      return paused
    },
  }
}
