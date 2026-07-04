export const HOOK_TOKEN_ENV_VAR = 'SLOPDECK_HOOK_TOKEN'

export type HttpHook = {
  readonly type: 'http'
  readonly url: string
  readonly headers: { readonly Authorization: string }
  /** Per-hook interpolation gate: without it, `$VAR` in headers resolves to
   * an empty string. A top-level settings key is silently ignored (verified
   * against a real claude binary, 2026-07-03). */
  readonly allowedEnvVars: readonly string[]
}

export type HookMatcher = { readonly matcher?: string; readonly hooks: readonly HttpHook[] }

export type HookSettings = {
  readonly hooks: {
    readonly Stop: readonly HookMatcher[]
    readonly UserPromptSubmit: readonly HookMatcher[]
    readonly PostToolUse: readonly HookMatcher[]
    readonly PermissionRequest: readonly HookMatcher[]
    /** Present only when the AskUserQuestion hack is opted into — the flag
     * must disable it independently of everything else (issue #11). */
    readonly PreToolUse?: readonly HookMatcher[]
  }
}

/**
 * The ticker's audit scope (D7): only write-capable tools. Read-only tools
 * are deliberately absent so reads never incur a hook round trip.
 */
export const TICKER_TOOL_MATCHER = 'Write|Edit|MultiEdit|NotebookEdit|Bash'

function normalizeGatewayUrl(raw: string): string {
  let parsed: URL
  try {
    parsed = new URL(raw)
  } catch {
    throw new Error(`gateway url is not a valid URL: ${raw}`)
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    throw new Error(`gateway url must be http(s), got ${parsed.protocol}`)
  }
  return parsed.origin + parsed.pathname.replace(/\/+$/, '')
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
export function generateHookSettings(options: {
  gatewayUrl: string
  /** D3's AskUserQuestion hack — undocumented behavior, so it stays opt-in
   * and matcher-isolated to AskUserQuestion alone. */
  interceptQuestions?: boolean
}): HookSettings {
  const base = normalizeGatewayUrl(options.gatewayUrl)

  const httpHook = (path: string): HookMatcher => ({
    hooks: [
      {
        type: 'http',
        url: `${base}${path}`,
        headers: { Authorization: `Bearer $${HOOK_TOKEN_ENV_VAR}` },
        allowedEnvVars: [HOOK_TOKEN_ENV_VAR],
      },
    ],
  })
  const ingestMatcher = httpHook('/api/events')

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
  }
}
