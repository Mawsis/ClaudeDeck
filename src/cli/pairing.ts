import { readCliConfig, type CliConfig } from './cli-config.ts'
import type { CliDeps, CliOutcome } from './install.ts'

/**
 * Phone pairing: a terminal QR encoding `<base>/#deck-token=<deckKey>`. The
 * deck key rides the URL fragment, so it never reaches an HTTP request or a
 * server log; it lives in the config file and leaves only as QR modules — never
 * plaintext on screen or in shell history.
 */

/** Build the fragment-pairing URL for a base the phone can reach. */
export function pairingUrl(baseUrl: string, deckKey: string): string {
  return `${baseUrl.replace(/\/+$/, '')}/#deck-token=${encodeURIComponent(deckKey)}`
}

/**
 * The base URL the phone actually dials. A hosted gateway is reachable at its
 * own domain; a localhost gateway is not — the phone must hit the machine's LAN
 * IP on the same Wi-Fi, so we swap localhost for the detected LAN IP (keeping
 * the port). Returns null if a local gateway has no detectable LAN IP.
 */
/** Hostnames a phone on the LAN can never dial: loopback and bind-all forms.
 * `new URL('http://[::1]:…').hostname` keeps the brackets, hence both spellings. */
const UNREACHABLE_HOSTS = new Set(['localhost', '127.0.0.1', '0.0.0.0', '::1', '[::1]'])

export function phoneReachableBase(deps: CliDeps, gatewayUrl: string): string | null {
  const url = new URL(gatewayUrl)
  if (!UNREACHABLE_HOSTS.has(url.hostname)) return url.origin
  const lanIp = deps.lanIp()
  if (lanIp === undefined) return null
  return `http://${lanIp}:${url.port || '8484'}`
}

/**
 * Render the pairing QR from a resolved config. The deck key comes from the
 * config file `install`/`rotate` wrote — no prompt. Re-runnable any time:
 * re-pairing after a new phone or a rotate is one scan.
 */
export function printPairingQr(deps: CliDeps, config: CliConfig): CliOutcome {
  const { io, renderQr } = deps
  if (config.deckKey === undefined) {
    io.say('no deck key in the config — run `slopdeck install` to mint one')
    return { ok: false }
  }
  const base = phoneReachableBase(deps, config.gatewayUrl)
  if (base === null) {
    io.say('could not detect a LAN IP for the local gateway — the phone cannot reach this machine')
    return { ok: false }
  }
  io.say(renderQr(pairingUrl(base, config.deckKey)))
  io.say('scan with the phone camera to pair the deck')
  return { ok: true }
}

export async function qr(deps: CliDeps): Promise<CliOutcome> {
  const config = await readCliConfig(deps.files, deps.paths.configFile)
  if (!config.ok) {
    deps.io.say(config.error)
    return { ok: false }
  }
  return printPairingQr(deps, config.config)
}
