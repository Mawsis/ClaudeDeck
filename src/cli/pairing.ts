import { readCliConfig } from './cli-config.ts'
import type { CliDeps, CliOutcome } from './install.ts'

/**
 * Phone pairing: a terminal QR encoding `https://<domain>/#deck-token=<token>`.
 * The token rides the URL fragment, so it never reaches HTTP requests or
 * server logs; on the CLI side it arrives by hidden prompt and leaves only
 * as QR modules — never plaintext on screen, in a file, or in shell history.
 */

export function pairingUrl(gatewayUrl: string, deckToken: string): string {
  return `${gatewayUrl.replace(/\/+$/, '')}/#deck-token=${encodeURIComponent(deckToken)}`
}

/** Prompt for the deck token and print the pairing QR. Re-runnable any time —
 * re-pairing after a domain change or a new phone is one scan. */
export async function printPairingQr(deps: CliDeps, gatewayUrl: string): Promise<CliOutcome> {
  const { io, renderQr } = deps
  const deckToken = await io.askHidden('deck token (shown on the gateway host, printed as a QR only)')
  if (deckToken === '') {
    io.say('no deck token provided — run `slopdeck qr` when you have it to pair the phone')
    return { ok: false }
  }
  io.say(renderQr(pairingUrl(gatewayUrl, deckToken)))
  io.say('scan with the phone camera to pair the deck')
  return { ok: true }
}

export async function qr(deps: CliDeps): Promise<CliOutcome> {
  const config = await readCliConfig(deps.files, deps.paths.configFile)
  if (!config.ok) {
    deps.io.say(config.error)
    return { ok: false }
  }
  return printPairingQr(deps, config.config.gatewayUrl)
}
