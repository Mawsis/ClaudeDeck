import { HOOK_TOKEN_ENV_VAR } from '../config-generator/generate.ts'
import { readCliConfig } from './cli-config.ts'
import type { CliDeps, CliOutcome } from './install.ts'
import { hasSlopdeckHooks, hookTokenFromSettings } from './settings-surgeon.ts'

/**
 * Remote controls for the gateway's pause state — the same switch the deck's
 * Pause tap toggles, with the CLI as a second remote. These commands never
 * touch settings files; hook install/removal is exclusively install/uninstall.
 */

export async function setInterception(deps: CliDeps, on: boolean): Promise<CliOutcome> {
  const { io, files, paths, createClient } = deps

  const config = await readCliConfig(files, paths.configFile)
  if (!config.ok) {
    io.say(config.error)
    return { ok: false }
  }
  // The deck key is stored at install — no prompt. A pre-workspaces config
  // (env-token era) without one points back at install.
  const deckKey = config.config.deckKey
  if (deckKey === undefined) {
    io.say('no deck key in the config — run `slopdeck install` to mint a workspace first')
    return { ok: false }
  }

  const client = createClient(config.config.gatewayUrl)
  const result = await client.setPaused(deckKey, !on)
  if (!result.ok) {
    // Hooks degrade to terminal on any non-2xx, so a dead gateway *is* the
    // off state — `off` reports that truth and succeeds instead of lying
    // that it changed something.
    if (!on && result.error === 'unreachable') {
      io.say('gateway unreachable — interception is already effectively off')
      return { ok: true }
    }
    io.say(
      result.error === 'unauthorized'
        ? 'deck token rejected by the gateway — interception state unchanged'
        : `could not turn interception ${on ? 'on' : 'off'}: gateway ${
            result.error === 'unreachable' ? `unreachable (${result.detail})` : `error (http ${result.status})`
          }`,
    )
    return { ok: false }
  }

  io.say(`interception ${result.value ? 'off' : 'on'} — the deck reflects the change live`)
  return { ok: true }
}

/**
 * The one-screen diagnostic mirror of the whole chain. Each link is checked
 * and reported independently, so any single misconfiguration is identifiable
 * at a glance; a link whose prerequisite is missing says "skipped (why)"
 * rather than failing in a misleading way.
 */
export async function status(deps: CliDeps): Promise<CliOutcome> {
  const { io, files, paths, env, createClient } = deps
  let failed = false
  const good = (line: string) => io.say(`  ok    ${line}`)
  const bad = (line: string) => {
    failed = true
    io.say(`  FAIL  ${line}`)
  }
  const skip = (line: string) => io.say(`  skip  ${line}`)

  const config = await readCliConfig(files, paths.configFile)
  if (config.ok) good(`config present at ${paths.configFile} (gateway ${config.config.gatewayUrl})`)
  else bad(config.error)

  const settings = await files.read(paths.claudeSettings)
  if (settings !== null && hasSlopdeckHooks(settings)) good(`hooks installed in ${paths.claudeSettings}`)
  else bad(`hooks not installed in ${paths.claudeSettings} — run \`slopdeck install\``)

  // The token lives in the settings `env` block (cross-platform), where Claude
  // Code reads it for hooks. Fall back to the shell env for legacy .zshrc
  // installs so an old setup still diagnoses correctly.
  const hookToken =
    (settings !== null ? hookTokenFromSettings(settings) : undefined) ?? env[HOOK_TOKEN_ENV_VAR]
  if (hookToken !== undefined && hookToken !== '') {
    good(`${HOOK_TOKEN_ENV_VAR} set in Claude settings`)
  } else {
    bad(`${HOOK_TOKEN_ENV_VAR} missing from ${paths.claudeSettings} — run \`slopdeck install\``)
  }

  if (!config.ok) {
    skip('gateway check skipped (no gateway URL without a config)')
    skip('hook token check skipped (no gateway URL without a config)')
    skip('pause state skipped (no gateway URL without a config)')
    return { ok: false }
  }

  const client = createClient(config.config.gatewayUrl)
  const health = await client.health()
  if (health.ok) good('gateway reachable')
  else bad(`gateway unreachable${health.error === 'unreachable' ? ` (${health.detail})` : ` (http ${health.status})`}`)

  if (hookToken === undefined || hookToken === '') {
    skip(`hook token check skipped (${HOOK_TOKEN_ENV_VAR} not set in Claude settings)`)
  } else if (!health.ok) {
    skip('hook token check skipped (gateway unreachable)')
  } else {
    const verified = await client.verifyHookToken(hookToken)
    if (verified.ok) good('hook token accepted by the gateway')
    else if (verified.error === 'unauthorized') bad('hook token rejected by the gateway')
    else bad(`hook token check failed: gateway error (${verified.error})`)
  }

  // The deck side of the workspace-scoped chain: the stored deck key must
  // resolve on the gateway (confirming key, gateway, and workspace agree) and
  // reports the live interception mode. No prompt — the key lives in the config.
  const deckKey = config.config.deckKey
  if (!health.ok) {
    skip('deck key check skipped (gateway unreachable)')
  } else if (deckKey === undefined) {
    skip('deck key check skipped (no deck key in config — re-run `slopdeck install`)')
  } else {
    const paused = await client.getPaused(deckKey)
    if (paused.ok) good(`deck key resolves its workspace — interception ${paused.value ? 'off (paused)' : 'on'}`)
    else if (paused.error === 'unauthorized') bad('deck key rejected by the gateway — the workspace it names no longer exists')
    else bad(`deck key check failed: gateway error (${paused.error})`)
  }

  return { ok: !failed }
}
