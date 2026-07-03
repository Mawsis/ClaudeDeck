export type GatewayConfig = {
  readonly hookToken: string
  readonly deckToken: string
  readonly port: number
}

const DEFAULT_PORT = 8484

function requireVar(env: Record<string, string | undefined>, name: string): string {
  const value = env[name]
  if (value === undefined || value === '') {
    throw new Error(`missing required environment variable ${name}`)
  }
  return value
}

export function loadConfigFromEnv(env: Record<string, string | undefined>): GatewayConfig {
  const hookToken = requireVar(env, 'CLAUDEDECK_HOOK_TOKEN')
  const deckToken = requireVar(env, 'CLAUDEDECK_DECK_TOKEN')
  if (hookToken === deckToken) {
    throw new Error('CLAUDEDECK_HOOK_TOKEN and CLAUDEDECK_DECK_TOKEN are identical — scopes must use distinct tokens')
  }

  const rawPort = env.PORT
  const port = rawPort === undefined || rawPort === '' ? DEFAULT_PORT : Number.parseInt(rawPort, 10)
  if (Number.isNaN(port) || port < 1 || port > 65535) {
    throw new Error(`PORT must be a number between 1 and 65535, got ${rawPort}`)
  }

  return { hookToken, deckToken, port }
}
