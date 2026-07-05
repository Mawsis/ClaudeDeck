/** D4: under the 600s hook timeout, so the terminal sees the no-decision
 * fallback rather than a hook error when a connected deck stays silent. */
export const DEFAULT_PERMISSION_TIMEOUT_MS = 540_000;
export function createPendingPromptStore(options) {
    const timeoutMs = options.timeoutMs ?? DEFAULT_PERMISSION_TIMEOUT_MS;
    const isPaused = options.isPaused ?? (() => false);
    const pending = new Map();
    const settle = (id, decision) => {
        const resolver = pending.get(id);
        if (resolver === undefined)
            return false;
        pending.delete(id);
        resolver(decision);
        return true;
    };
    return {
        hold() {
            const id = crypto.randomUUID();
            // Fall back before the prompt is ever pending when there is nothing to
            // hold *for*: no deck to render the card (D4), or the deck flipped to
            // passthrough (D5) — both mean "let the terminal dialog proceed now".
            if (!options.hasDeck() || isPaused()) {
                return { id, decision: Promise.resolve(null), pending: false };
            }
            const decision = new Promise((resolver) => {
                pending.set(id, resolver);
            });
            const timer = setTimeout(() => settle(id, null), timeoutMs);
            // Whatever settles first wins; the loser's branch is a no-op.
            void decision.then(() => clearTimeout(timer));
            return { id, decision, pending: true };
        },
        resolve(id, decision) {
            return settle(id, decision);
        },
    };
}
