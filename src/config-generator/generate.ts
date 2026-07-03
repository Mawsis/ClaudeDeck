export const HOOK_TOKEN_ENV_VAR = 'CLAUDEDECK_HOOK_TOKEN'

export type HttpHook = {
  readonly type: 'http'
  readonly url: string
  readonly headers: { readonly Authorization: string }
}

export type HookSettings = {
  readonly hooks: {
    readonly Stop: ReadonlyArray<{ readonly hooks: readonly HttpHook[] }>
  }
  readonly allowedEnvVars: readonly string[]
}

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
 * Emits the Claude Code settings block registering ClaudeDeck's Stop hook.
 * The generator never sees the secret itself — the Authorization header is
 * the `$VAR` interpolation form, resolved by Claude Code at hook time and
 * gated by `allowedEnvVars`.
 */
export function generateHookSettings(options: { gatewayUrl: string }): HookSettings {
  const base = normalizeGatewayUrl(options.gatewayUrl)

  return {
    hooks: {
      Stop: [
        {
          hooks: [
            {
              type: 'http',
              url: `${base}/api/events`,
              headers: { Authorization: `Bearer $${HOOK_TOKEN_ENV_VAR}` },
            },
          ],
        },
      ],
    },
    allowedEnvVars: [HOOK_TOKEN_ENV_VAR],
  }
}
