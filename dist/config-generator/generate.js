export const HOOK_TOKEN_ENV_VAR = 'SLOPDECK_HOOK_TOKEN';
/**
 * The ticker's audit scope (D7): only write-capable tools. Read-only tools
 * are deliberately absent so reads never incur a hook round trip.
 */
export const TICKER_TOOL_MATCHER = 'Write|Edit|MultiEdit|NotebookEdit|Bash';
function normalizeGatewayUrl(raw) {
    let parsed;
    try {
        parsed = new URL(raw);
    }
    catch {
        throw new Error(`gateway url is not a valid URL: ${raw}`);
    }
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
        throw new Error(`gateway url must be http(s), got ${parsed.protocol}`);
    }
    return parsed.origin + parsed.pathname.replace(/\/+$/, '');
}
/**
 * Emits the Claude Code settings block registering slopdeck's hooks:
 * lifecycle (Stop + UserPromptSubmit), ticker (PostToolUse), and the
 * permission gate (PermissionRequest — fires only when a dialog would
 * genuinely appear, so allowlisted commands never reach the deck, per D3).
 * The generator never sees the secret itself — the Authorization header is
 * the `$VAR` interpolation form, resolved by Claude Code at hook time and
 * gated by `allowedEnvVars`.
 */
export function generateHookSettings(options) {
    const base = normalizeGatewayUrl(options.gatewayUrl);
    const httpHook = (path) => ({
        hooks: [
            {
                type: 'http',
                url: `${base}${path}`,
                headers: { Authorization: `Bearer $${HOOK_TOKEN_ENV_VAR}` },
                allowedEnvVars: [HOOK_TOKEN_ENV_VAR],
            },
        ],
    });
    const ingestMatcher = httpHook('/api/events');
    return {
        hooks: {
            Stop: [ingestMatcher],
            UserPromptSubmit: [ingestMatcher],
            PostToolUse: [{ matcher: TICKER_TOOL_MATCHER, ...ingestMatcher }],
            PermissionRequest: [httpHook('/api/permission')],
            ...(options.interceptQuestions === true
                ? { PreToolUse: [{ matcher: 'AskUserQuestion', ...httpHook('/api/question') }] }
                : {}),
        },
    };
}
