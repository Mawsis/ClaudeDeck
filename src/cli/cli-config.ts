import type { FileStore } from './install.ts'

/**
 * Reads the config file `install` wrote. Every post-install command starts
 * here; a missing or malformed file is a typed error pointing at `install`,
 * never a throw.
 */

export type CliConfig = {
  readonly gatewayUrl: string
  readonly interceptQuestions: boolean
}

export type CliConfigResult =
  | { readonly ok: true; readonly config: CliConfig }
  | { readonly ok: false; readonly error: string }

export async function readCliConfig(files: FileStore, configFile: string): Promise<CliConfigResult> {
  const content = await files.read(configFile)
  if (content === null) {
    return { ok: false, error: `no config at ${configFile} — run \`slopdeck install\` first` }
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(content)
  } catch {
    parsed = null
  }
  const gatewayUrl =
    typeof parsed === 'object' && parsed !== null
      ? (parsed as Record<string, unknown>).gatewayUrl
      : undefined
  if (typeof gatewayUrl !== 'string' || gatewayUrl === '') {
    return { ok: false, error: `config at ${configFile} is malformed — re-run \`slopdeck install\`` }
  }
  const interceptQuestions = (parsed as Record<string, unknown>).interceptQuestions === true
  return { ok: true, config: { gatewayUrl, interceptQuestions } }
}
