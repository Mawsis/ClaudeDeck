export const HOOK_TOKEN_ENV_VAR = 'CLAUDEDECK_HOOK_TOKEN'

export type HttpHook = {
  readonly type: 'http'
  readonly url: string
  readonly headers: { readonly Authorization: string }
}

export type HookMatcher = { readonly matcher?: string; readonly hooks: readonly HttpHook[] }

export type HookSettings = {
  readonly hooks: {
    readonly Stop: readonly HookMatcher[]
    readonly UserPromptSubmit: readonly HookMatcher[]
    readonly PostToolUse: readonly HookMatcher[]
  }
  readonly allowedEnvVars: readonly string[]
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
 * Emits the Claude Code settings block registering ClaudeDeck's lifecycle
 * hooks (Stop + UserPromptSubmit). The generator never sees the secret
 * itself — the Authorization header is the `$VAR` interpolation form,
 * resolved by Claude Code at hook time and gated by `allowedEnvVars`.
 */
export function generateHookSettings(options: { gatewayUrl: string }): HookSettings {
  const base = normalizeGatewayUrl(options.gatewayUrl)

  const ingestMatcher: HookMatcher = {
    hooks: [
      {
        type: 'http',
        url: `${base}/api/events`,
        headers: { Authorization: `Bearer $${HOOK_TOKEN_ENV_VAR}` },
      },
    ],
  }

  return {
    hooks: {
      Stop: [ingestMatcher],
      UserPromptSubmit: [ingestMatcher],
      PostToolUse: [{ matcher: TICKER_TOOL_MATCHER, ...ingestMatcher }],
    },
    allowedEnvVars: [HOOK_TOKEN_ENV_VAR],
  }
}
