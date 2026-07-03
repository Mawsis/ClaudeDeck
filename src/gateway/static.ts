import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

export function loadPwaHtml(): string {
  return readFileSync(fileURLToPath(new URL('../pwa/index.html', import.meta.url)), 'utf8')
}
