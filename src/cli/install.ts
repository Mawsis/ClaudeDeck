import { generateHookSettings } from '../config-generator/generate.ts'
import type { GatewayClient } from './gateway-client.ts'
import { pairingUrl, phoneReachableBase } from './pairing.ts'
import {
  addHookSettings,
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
  /** Hidden input — a key must never echo to the terminal. */
  askHidden(question: string): Promise<string>
  confirm(question: string, defaultYes: boolean): Promise<boolean>
  /** Single-choice menu; returns the chosen option (one of `choices`). */
  choose(question: string, choices: readonly string[]): Promise<string>
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
  /** The machine's LAN IP for the local path (first non-internal IPv4), or
   * undefined if none was found. Injected so the flow stays testable. */
  readonly lanIp: () => string | undefined
  /** Where the CLI was invoked — the handshake event carries it so the deck
   * ticker shows a recognizable name. */
  readonly cwd: string
}

export type CliOutcome = { readonly ok: boolean }

/** The default hosted gateway — the author's always-on backend. */
export const HOSTED_GATEWAY_URL = 'https://slopdeck.mawsis.dev'

const LOCAL = 'local'
const HOSTED = 'hosted'

/** The honest privacy line and the loud anonymous-key warning, printed on every
 * install so the tradeoffs are never hidden behind a happy path. */
const PRIVACY_LINE =
  'privacy: the deck sees your project folder names and shell command payloads and the questions Claude asks — not your credentials or file contents.'
const KEY_WARNING =
  'IMPORTANT: this workspace key is the only way to reach your deck. Save it (or sign up later to recover it) — if you lose it, you cannot get back in and anyone who has it can see your sessions.'

export async function install(
  deps: CliDeps,
  options: { readonly gatewayUrl?: string | undefined },
): Promise<CliOutcome> {
  const { io, files, paths, createClient } = deps

  const mode = await io.choose('run slopdeck locally or use the hosted gateway?', [LOCAL, HOSTED])

  // Resolve the gateway URL and mint a fresh workspace — never a hand-typed or
  // hand-generated token. Local mints against the machine's own ungated
  // endpoint; hosted mints against the public one.
  const gatewayUrl =
    options.gatewayUrl ?? (mode === HOSTED ? HOSTED_GATEWAY_URL : await io.ask('local gateway URL'))
  const client = createClient(gatewayUrl)

  const minted = mode === HOSTED ? await client.mintHosted() : await client.mintLocal()
  if (!minted.ok) {
    io.say(
      minted.error === 'unreachable'
        ? `gateway unreachable at ${gatewayUrl}: ${minted.detail}`
        : `could not mint a workspace at ${gatewayUrl}: gateway error (${
            minted.error === 'http' ? `http ${minted.status}` : minted.error
          })`,
    )
    return { ok: false }
  }
  const { hookKey, deckKey } = minted.value

  // The phone reaches a local gateway over the machine's LAN IP on the same
  // Wi-Fi; the hosted one over its real domain. Resolve the reachable base
  // BEFORE writing anything, so a local machine with no LAN IP aborts clean.
  const pairingBase = phoneReachableBase(deps, gatewayUrl)
  if (pairingBase === null) {
    io.say('could not detect a LAN IP — the phone must reach this machine directly; nothing was written')
    return { ok: false }
  }
  if (mode === LOCAL) {
    io.say('note: on the LAN you get in-page alerts only; locked-screen notifications need the hosted option.')
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
    // The hook token now rides in the settings `env` block, which Claude Code
    // injects into hook execution on every OS. The old .zshrc export only
    // worked on Unix shells — Windows hooks got no token and 401'd.
    hookKey,
  )
  if (!surgery.ok) {
    io.say(`refusing to touch ${paths.claudeSettings}: ${surgery.error}`)
    return { ok: false }
  }

  await files.write(
    paths.configFile,
    // The deck key is stored here — it is the phone-pairing credential and the
    // proof `rotate` presents. The hook key is deliberately absent: it lives
    // in the settings `env` block, where Claude Code's hook interpolation picks
    // it up cross-platform.
    JSON.stringify({ gatewayUrl, interceptQuestions, deckKey }, null, 2) + '\n',
  )
  await files.write(paths.claudeSettings, surgery.content)

  io.say('slopdeck installed — the hook token is set in Claude settings (no shell restart needed)')

  // The pairing finale: QR for the phone, the honest privacy line, the loud
  // key warning, then a handshake through the real hook-auth path — one moment
  // that proves DNS/LAN, the hook key, gateway, SSE, and deck end to end.
  io.say(deps.renderQr(pairingUrl(pairingBase, deckKey)))
  io.say('scan with the phone camera to pair the deck')
  io.say(PRIVACY_LINE)
  io.say(KEY_WARNING)

  const handshake = await client.handshake(hookKey, {
    sessionId: 'slopdeck-install',
    cwd: deps.cwd,
  })
  if (!handshake.ok) {
    io.say(
      'handshake failed — the setup files are in place, but the pipeline proof did not go through. ' +
        'Check that the gateway is still running.',
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
