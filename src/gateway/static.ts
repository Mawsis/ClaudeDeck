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
