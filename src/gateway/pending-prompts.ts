/** D3: the deck's answer to a permission dialog. `null` means "no decision" —
 * the terminal dialog proceeds normally (Ask-in-terminal and every fallback). */
export type PermissionDecision = { readonly behavior: 'allow' | 'deny' }

export type HeldPrompt<TDecision = PermissionDecision> = {
  readonly id: string
  readonly decision: Promise<TDecision | null>
  /** False when the no-deck fallback answered at hold time — the prompt was
   * never pending, so nothing should alert or render for it. */
  readonly pending: boolean
}

export type PendingPromptStore<TDecision = PermissionDecision> = {
  hold(): HeldPrompt<TDecision>
  resolve(id: string, decision: TDecision | null): boolean
}

/** D4: under the 600s hook timeout, so the terminal sees the no-decision
 * fallback rather than a hook error when a connected deck stays silent. */
export const DEFAULT_PERMISSION_TIMEOUT_MS = 540_000

export function createPendingPromptStore<TDecision = PermissionDecision>(options: {
  hasDeck: () => boolean
  /** D5: paused → passthrough. Absent means never paused (always intercept). */
  isPaused?: () => boolean
  timeoutMs?: number
}): PendingPromptStore<TDecision> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_PERMISSION_TIMEOUT_MS
  const isPaused = options.isPaused ?? (() => false)
  const pending = new Map<string, (decision: TDecision | null) => void>()

  const settle = (id: string, decision: TDecision | null): boolean => {
    const resolver = pending.get(id)
    if (resolver === undefined) return false
    pending.delete(id)
    resolver(decision)
    return true
  }

  return {
    hold() {
      const id = crypto.randomUUID()
      // Fall back before the prompt is ever pending when there is nothing to
      // hold *for*: no deck to render the card (D4), or the deck flipped to
      // passthrough (D5) — both mean "let the terminal dialog proceed now".
      if (!options.hasDeck() || isPaused()) {
        return { id, decision: Promise.resolve(null), pending: false }
      }
      const decision = new Promise<TDecision | null>((resolver) => {
        pending.set(id, resolver)
      })
      const timer = setTimeout(() => settle(id, null), timeoutMs)
      // Whatever settles first wins; the loser's branch is a no-op.
      void decision.then(() => clearTimeout(timer))
      return { id, decision, pending: true }
    },

    resolve(id, decision) {
      return settle(id, decision)
    },
  }
}
