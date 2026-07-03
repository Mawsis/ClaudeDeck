/** D3: the deck's answer to a permission dialog. `null` means "no decision" —
 * the terminal dialog proceeds normally (Ask-in-terminal and every fallback). */
export type PermissionDecision = { readonly behavior: 'allow' | 'deny' }

export type HeldPrompt = {
  readonly id: string
  readonly decision: Promise<PermissionDecision | null>
  /** False when the no-deck fallback answered at hold time — the prompt was
   * never pending, so nothing should alert or render for it. */
  readonly pending: boolean
}

export type PendingPromptStore = {
  hold(): HeldPrompt
  resolve(id: string, decision: PermissionDecision | null): boolean
}

/** D4: under the 600s hook timeout, so the terminal sees the no-decision
 * fallback rather than a hook error when a connected deck stays silent. */
export const DEFAULT_PERMISSION_TIMEOUT_MS = 540_000

export function createPendingPromptStore(options: {
  hasDeck: () => boolean
  timeoutMs?: number
}): PendingPromptStore {
  const timeoutMs = options.timeoutMs ?? DEFAULT_PERMISSION_TIMEOUT_MS
  const pending = new Map<string, (decision: PermissionDecision | null) => void>()

  const settle = (id: string, decision: PermissionDecision | null): boolean => {
    const resolver = pending.get(id)
    if (resolver === undefined) return false
    pending.delete(id)
    resolver(decision)
    return true
  }

  return {
    hold() {
      const id = crypto.randomUUID()
      // D4: with no deck to render the card, holding would only delay the
      // terminal dialog — fall back before the prompt is ever pending.
      if (!options.hasDeck()) {
        return { id, decision: Promise.resolve(null), pending: false }
      }
      const decision = new Promise<PermissionDecision | null>((resolver) => {
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
