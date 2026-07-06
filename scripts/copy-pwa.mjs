#!/usr/bin/env node
// Copy the non-JS PWA assets that `tsc` never emits into the published tree.
//
// The build compiles `src/pwa/deck-reducer.js` to `dist/pwa/deck-reducer.js`,
// but leaves `index.html`, `sw.js`, and `brand/**` behind — so an installed
// package (which must run `dist/`, not strip types from `src/`) throws ENOENT
// when static.ts loads them. This script closes that gap and runs on every
// build, so the copied assets never drift from source (#51).
//
// Usage: node scripts/copy-pwa.mjs [srcPwaDir] [destPwaDir]
// Defaults resolve to <repo>/src/pwa and <repo>/dist/pwa.
import { cp, mkdir } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const srcDir = resolve(process.argv[2] ?? join(repoRoot, 'src', 'pwa'))
const destDir = resolve(process.argv[3] ?? join(repoRoot, 'dist', 'pwa'))

// Whatever `tsc` already emits (deck-reducer.js) is deliberately absent here —
// this list is exactly the assets the compiler drops. `brand` is a directory,
// copied whole so a new sprite ships without touching this script.
const ASSETS = ['index.html', 'sw.js', 'brand']

await mkdir(destDir, { recursive: true })
for (const asset of ASSETS) {
  await cp(join(srcDir, asset), join(destDir, asset), { recursive: true })
}
