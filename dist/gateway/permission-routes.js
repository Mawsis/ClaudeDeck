import { basename } from 'node:path';
import { requireWorkspace } from "./auth.js";
import { classifyBash } from "./bash-classifier.js";
import { clampDetail, extractToolDetail, permissionDetail } from "./tool-detail.js";
const MAX_TITLE_LENGTH = 120;
function parsePermissionPayload(body) {
    if (typeof body !== 'object' || body === null)
        return undefined;
    const record = body;
    if (record.hook_event_name !== 'PermissionRequest')
        return undefined;
    if (typeof record.session_id !== 'string' || record.session_id === '')
        return undefined;
    if (typeof record.cwd !== 'string' || record.cwd === '')
        return undefined;
    if (typeof record.tool_name !== 'string' || record.tool_name === '')
        return undefined;
    return {
        session_id: record.session_id,
        cwd: record.cwd,
        tool_name: record.tool_name,
        tool_input: record.tool_input,
    };
}
const RESOLUTION_ACTIONS = ['allow', 'deny', 'ask'];
function parseResolutionAction(body) {
    if (typeof body !== 'object' || body === null)
        return undefined;
    const action = body.action;
    return RESOLUTION_ACTIONS.find((known) => known === action);
}
/**
 * The permission gate (D3/D4): a PermissionRequest http hook is held open
 * while the deck decides, then answered with the documented decision JSON —
 * or with `{}` (no decision, the terminal dialog proceeds) for Ask-in-terminal
 * and every fallback. Never auto-deny. Every hold, event, and resolution is
 * scoped to the caller's workspace runtime — a prompt on workspace A can only
 * be rendered and answered by A's deck.
 */
export function registerPermissionRoutes(app, config) {
    const { store, runtimeFor, pushRegistry } = config;
    app.post('/api/permission', requireWorkspace('hook', store), async (c) => {
        const { eventLog, permStore: promptStore } = runtimeFor(c.get('workspaceId'));
        let body;
        try {
            body = await c.req.json();
        }
        catch {
            return c.json({ error: 'body must be JSON' }, 400);
        }
        const payload = parsePermissionPayload(body);
        if (payload === undefined) {
            return c.json({ error: 'expected a PermissionRequest hook payload with session_id, cwd, and tool_name' }, 400);
        }
        const held = promptStore.hold();
        const base = {
            sessionId: payload.session_id,
            title: basename(payload.cwd).slice(0, MAX_TITLE_LENGTH),
            cwd: payload.cwd,
            promptId: held.id,
        };
        // Claude Code races its own terminal dialog against this http hook. When the
        // user answers in the terminal, Claude aborts the in-flight hook request —
        // so if the request disconnects while we're still holding, the prompt was
        // answered at the terminal. Resolve it as a no-decision (the terminal
        // already acted); the resolution below then publishes permission-resolved
        // and the deck clears its now-stale card. Harmless if the deck already
        // resolved it — settle() is a no-op on an unknown/already-settled id.
        const signal = c.req.raw.signal;
        if (signal !== undefined) {
            const onAbort = () => promptStore.resolve(held.id, null);
            if (signal.aborted)
                onAbort();
            else
                signal.addEventListener('abort', onAbort, { once: true });
        }
        const detail = permissionDetail(payload.tool_input, payload.cwd);
        // D15: risk comes from the raw command, never the display-truncated
        // detail — a truncated tail must not hide the destructive part. Scoped
        // to Bash by design: D15's high-risk table is the Bash classifier, and
        // every other tool's card keeps the standard hold.
        const risk = payload.tool_name === 'Bash' &&
            classifyBash(extractToolDetail(payload.tool_input, payload.cwd)).risk === 'high'
            ? 'high'
            : 'routine';
        eventLog.publish({ type: 'permission', ...base, tool: payload.tool_name, detail, risk });
        // D11: pending prompts always alert — they block a session. A prompt the
        // no-deck fallback already answered was never pending; alerting for a
        // card that doesn't exist would be a lie. The service worker drops the
        // push when a deck window is visible (the takeover is the alert there).
        // The full payload lives on the approval card; the push only says "come
        // look" and must stay under the ~4KB Web Push payload cap.
        if (held.pending) {
            pushRegistry?.broadcast(JSON.stringify({
                kind: 'permission',
                title: base.title,
                tool: payload.tool_name,
                detail: clampDetail(detail),
            }));
        }
        const decision = await held.decision;
        eventLog.publish({
            type: 'permission-resolved',
            ...base,
            outcome: decision?.behavior ?? 'ask',
        });
        if (decision === null)
            return c.json({}, 200);
        return c.json({ hookSpecificOutput: { hookEventName: 'PermissionRequest', decision } }, 200);
    });
    app.post('/api/prompts/:id/resolution', requireWorkspace('deck', store), async (c) => {
        const { permStore: promptStore } = runtimeFor(c.get('workspaceId'));
        let body;
        try {
            body = await c.req.json();
        }
        catch {
            return c.json({ error: 'body must be JSON' }, 400);
        }
        const action = parseResolutionAction(body);
        if (action === undefined) {
            return c.json({ error: 'expected { action: "allow" | "deny" | "ask" }' }, 400);
        }
        // Ask-in-terminal is a real answer whose content is "no decision" —
        // the terminal dialog proceeds (D3).
        const decision = action === 'ask' ? null : { behavior: action };
        if (!promptStore.resolve(c.req.param('id'), decision)) {
            return c.json({ error: 'unknown or already resolved prompt' }, 404);
        }
        return c.json({ ok: true }, 200);
    });
}
