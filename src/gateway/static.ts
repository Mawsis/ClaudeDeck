import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

function loadPwaAsset(filename: string): string {
  return readFileSync(fileURLToPath(new URL(`../pwa/${filename}`, import.meta.url)), 'utf8')
}

export function loadPwaHtml(): string {
  return loadPwaAsset('index.html')
}

export function loadDeckReducerJs(): string {
  return loadPwaAsset('deck-reducer.js')
}

export function loadServiceWorkerJs(): string {
  return loadPwaAsset('sw.js')
}

// The swappable brand directory (issue: rebrand = asset swap, not a refactor).
// Loaded as an explicit whitelist at startup: the route serves map hits only,
// so a request path can never reach the filesystem.
const BRAND_ASSETS = [
  'icon.svg',
  'clawd-sleeping.svg',
  'clawd-typing.svg',
  'clawd-waving.svg',
  'clawd-alarmed.svg',
  'clawd-paused.svg',
  'clawd-offline.svg',
] as const

export function loadBrandAssets(): ReadonlyMap<string, string> {
  return new Map(BRAND_ASSETS.map((name) => [name, loadPwaAsset(`brand/${name}`)]))
}
