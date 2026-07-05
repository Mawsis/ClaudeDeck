import { generateHookSettings } from '../config-generator/generate.ts'
import type { GatewayClient } from './gateway-client.ts'
import { printPairingQr } from './pairing.ts'
import {
  addHookSettings,
  addZshrcBlock,
  removeHookSettings,
  removeZshrcBlock,
} from './settings-surgeon.ts'

/**
 * The install/uninstall flows as pure orchestration over injected I/O. The
 * ironclad rule both directions share: validate everything first, then write
 * everything — a failed check or a malformed file must leave the disk
 * exactly as it was found.
 */

export type CliIo = {
  ask(question: string): Promise<string>
  /** Hidden input — the hook token must never echo to the terminal. */
  askHidden(question: string): Promise<string>
  confirm(question: string, defaultYes: boolean): Promise<boolean>
  say(line: string): void
}

export type FileStore = {
  /** null = the file does not exist. */
  read(path: string): Promise<string | null>
  write(path: string, content: string): Promise<void>
  remove(path: string): Promise<void>
}

export type CliPaths = {
  readonly configFile: string
  readonly claudeSettings: string
  readonly zshrc: string
}

export type CliDeps = {
  readonly io: CliIo
  readonly files: FileStore
  readonly paths: CliPaths
  readonly createClient: (gatewayUrl: string) => GatewayClient
  /** Shell environment — `status` diagnoses what this shell actually exports. */
  readonly env: Readonly<Record<string, string | undefined>>
  /** Renders text as a terminal QR block; injected so tests see the encoded text. */
  readonly renderQr: (text: string) => string
  /** Where the CLI was invoked — the handshake event carries it so the deck
   * ticker shows a recognizable name. */
  readonly cwd: string
}

export type CliOutcome = { readonly ok: boolean }

export async function install(
  deps: CliDeps,
  options: { readonly gatewayUrl?: string | undefined },
): Promise<CliOutcome> {
  const { io, files, paths, createClient } = deps

  const gatewayUrl = options.gatewayUrl ?? (await io.ask('gateway URL'))
  const client = createClient(gatewayUrl)

  const health = await client.health()
  if (!health.ok) {
    io.say(
      health.error === 'unreachable'
        ? `gateway unreachable at ${gatewayUrl}: ${health.detail}`
        : `gateway at ${gatewayUrl} answered with an error — check the URL`,
    )
    return { ok: false }
  }

  const hookToken = await io.askHidden('hook token')
  const verified = await client.verifyHookToken(hookToken)
  if (!verified.ok) {
    io.say(
      verified.error === 'unauthorized'
        ? 'hook token rejected by the gateway — nothing was written; check the token and retry'
        : `could not verify the hook token: gateway error (${verified.error})`,
    )
    return { ok: false }
  }

  const interceptQuestions = await io.confirm(
    'enable question interception (answer AskUserQuestion from the deck — undocumented hack)?',
    false,
  )

  // Compute every file edit before writing any of them: a malformed settings
  // file must abort with the disk untouched — the config file included.
  const settingsBefore = (await files.read(paths.claudeSettings)) ?? ''
  const surgery = addHookSettings(
    settingsBefore,
    generateHookSettings({ gatewayUrl, interceptQuestions }),
  )
  if (!surgery.ok) {
    io.say(`refusing to touch ${paths.claudeSettings}: ${surgery.error}`)
    return { ok: false }
  }
  const zshrcBefore = (await files.read(paths.zshrc)) ?? ''

  await files.write(
    paths.configFile,
    // The hook token is deliberately absent — it lives only in the marked
    // .zshrc block, where Claude Code's env interpolation picks it up.
    JSON.stringify({ gatewayUrl, interceptQuestions }, null, 2) + '\n',
  )
  await files.write(paths.claudeSettings, surgery.content)
  await files.write(paths.zshrc, addZshrcBlock(zshrcBefore, hookToken))

  io.say('slopdeck installed — open a new shell so the hook token is exported')

  // The pairing finale: QR for the phone, then a handshake through the real
  // hook-auth path — one moment that proves DNS, TLS, hook token, gateway,
  // SSE, and deck token end to end. A skipped QR (no deck token yet) still
  // gets the pipeline proof.
  await printPairingQr(deps, gatewayUrl)
  const handshake = await client.handshake(hookToken, {
    sessionId: 'slopdeck-install',
    cwd: deps.cwd,
  })
  if (!handshake.ok) {
    io.say(
      'handshake failed — the setup files are in place, but the pipeline proof did not go through. ' +
        'Check that the gateway is still running and that the hook token you entered matches its SLOPDECK_HOOK_TOKEN.',
    )
    return { ok: false }
  }
  io.say('handshake sent — look at your phone: the mascot waves when the whole chain works')
  return { ok: true }
}

export async function uninstall(deps: CliDeps): Promise<CliOutcome> {
  const { io, files, paths } = deps

  // Same validate-then-write discipline in reverse. Removal keys on
  // slopdeck's own fingerprints, so no config file is needed to undo.
  const settingsBefore = await files.read(paths.claudeSettings)
  const surgery = settingsBefore === null ? null : removeHookSettings(settingsBefore)
  if (surgery !== null && !surgery.ok) {
    io.say(`refusing to touch ${paths.claudeSettings}: ${surgery.error}`)
    return { ok: false }
  }
  const zshrcBefore = await files.read(paths.zshrc)

  if (surgery !== null) await files.write(paths.claudeSettings, surgery.content)
  if (zshrcBefore !== null) await files.write(paths.zshrc, removeZshrcBlock(zshrcBefore))
  await files.remove(paths.configFile)

  io.say('slopdeck uninstalled — already-running Claude sessions keep their hooks until restarted')
  return { ok: true }
}
