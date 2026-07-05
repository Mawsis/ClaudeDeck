import { completionAlert, initialDeckState, reduceDeck } from '../pwa/deck-reducer.js';
import { createEventLog } from "./event-log.js";
import { createPauseState } from "./pause-state.js";
import { createPendingPromptStore, } from "./pending-prompts.js";
/**
 * Builds one workspace's isolated runtime. The alert-mirroring subscriber lives
 * here so each workspace's completion pushes are computed from its own deck
 * state — never another workspace's.
 */
export function createWorkspaceRuntime(options) {
    const eventLog = createEventLog(options.now ? { now: options.now } : {});
    const pauseState = createPauseState();
    const streamClosers = [];
    const hasDeck = () => streamClosers.length > 0;
    const permStore = createPendingPromptStore({
        hasDeck,
        isPaused: () => pauseState.isPaused(),
        ...(options.permissionTimeoutMs !== undefined ? { timeoutMs: options.permissionTimeoutMs } : {}),
    });
    const questionStore = createPendingPromptStore({
        hasDeck,
        isPaused: () => pauseState.isPaused(),
        timeoutMs: options.questionTimeoutMs,
    });
    // The gateway mirrors this workspace's deck state through the same pure
    // reducer so a completion alert still fires when the deck is dark — computed
    // from THIS workspace's state alone.
    const pushRegistry = options.pushRegistry;
    if (pushRegistry !== undefined) {
        let deckState = initialDeckState;
        eventLog.subscribe((event) => {
            if (event.type !== 'prompt' && event.type !== 'stop')
                return;
            const alert = completionAlert(deckState, event, { thresholdMs: options.alertThresholdMs });
            deckState = reduceDeck(deckState, event);
            if (alert === null)
                return;
            pushRegistry.broadcast(JSON.stringify({ title: alert.title, elapsedMs: alert.elapsedMs }));
        });
    }
    return {
        eventLog,
        pauseState,
        permStore,
        questionStore,
        heldQuestions: new Map(),
        streamClosers,
        hasDeck,
    };
}
