import { readCliConfig } from './cli-config.ts'
import type { CliDeps, CliOutcome } from './install.ts'
import { printPairingQr } from './pairing.ts'
import { setHookToken } from './settings-surgeon.ts'

/**
 * `slopdeck rotate` re-keys a workspace whose key leaked (a screenshotted QR, a
 * committed dotfile). Holding the current key IS the auth — no account. It
 * presents the config's deck key as proof, the gateway mints a fresh hook+deck
 * pair and kills both old keys, and the CLI re-inscribes: new hook key in the
 * Claude settings `env` block, new deck key in the config, and a reprinted QR.
 * Validate first, write second — a rejected rotation leaves every file as it was.
 */
export async function rotate(deps: CliDeps): Promise<CliOutcome> {
  const { io, files, paths, createClient } = deps

  const config = await readCliConfig(files, paths.configFile)
  if (!config.ok) {
    io.say(config.error)
    return { ok: false }
  }
  const { gatewayUrl, interceptQuestions, deckKey } = config.config
  if (deckKey === undefined) {
    io.say('no deck key in the config — run `slopdeck install` to mint a workspace first')
    return { ok: false }
  }

  // The current deck key is the proof of ownership. Only on a confirmed rotation
  // do we touch any file — a rejected rotate must not leave a half-re-keyed disk.
  const client = createClient(gatewayUrl)
  const rotated = await client.rotate(deckKey)
  if (!rotated.ok) {
    io.say(
      rotated.error === 'unauthorized'
        ? 'the current key was rejected — nothing was changed; is this config still valid?'
        : rotated.error === 'unreachable'
          ? `gateway unreachable at ${gatewayUrl}: ${rotated.detail} — nothing was changed`
          : `could not rotate: gateway error (http ${rotated.status}) — nothing was changed`,
    )
    return { ok: false }
  }

  // Re-inscribe the fresh hook token into the Claude settings `env` block (where
  // hooks read it cross-platform). Validate the surgery before writing anything.
  const settingsBefore = (await files.read(paths.claudeSettings)) ?? ''
  const surgery = setHookToken(settingsBefore, rotated.value.hookKey)
  if (!surgery.ok) {
    io.say(`refusing to touch ${paths.claudeSettings}: ${surgery.error} — nothing was changed`)
    return { ok: false }
  }
  await files.write(paths.claudeSettings, surgery.content)
  await files.write(
    paths.configFile,
    JSON.stringify({ gatewayUrl, interceptQuestions, deckKey: rotated.value.deckKey }, null, 2) + '\n',
  )

  io.say('rotated — the old key is dead; the fresh hook token is set in Claude settings')
  io.say('your currently-paired phone is now disconnected; it reconnects when it re-scans the QR below')
  printPairingQr(deps, {
    gatewayUrl,
    interceptQuestions,
    deckKey: rotated.value.deckKey,
  })
  return { ok: true }
}
