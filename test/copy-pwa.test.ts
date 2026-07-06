import { execFile } from 'node:child_process'
import { mkdtemp, readdir, rm } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { BRAND_ASSETS } from '../src/gateway/static.js'

const run = promisify(execFile)

const COPY_SCRIPT = fileURLToPath(new URL('../scripts/copy-pwa.mjs', import.meta.url))
const SRC_PWA = fileURLToPath(new URL('../src/pwa', import.meta.url))

// Every non-JS asset static.ts loads at runtime — the files tsc never copies, so
// the deck HTML, service worker, and mascot sprites can only reach dist/pwa/ via
// this script. deck-reducer.js is excluded here: tsc already emits it.
const REQUIRED_ASSETS = [
  'index.html',
  'sw.js',
  'brand/icon.svg',
  'brand/clawd-sleeping.svg',
  'brand/clawd-typing.svg',
  'brand/clawd-waving.svg',
  'brand/clawd-alarmed.svg',
  'brand/clawd-paused.svg',
  'brand/clawd-offline.svg',
] as const

let outDir: string

beforeEach(async () => {
  outDir = await mkdtemp(join(tmpdir(), 'slopdeck-pwa-'))
})

afterEach(async () => {
  await rm(outDir, { recursive: true, force: true })
})

describe('copy-pwa', () => {
  it('copies every runtime PWA asset from src/pwa into the target dir', async () => {
    await run('node', [COPY_SCRIPT, SRC_PWA, outDir])

    for (const asset of REQUIRED_ASSETS) {
      expect(existsSync(join(outDir, asset)), asset).toBe(true)
    }
  })

  it('copies every brand sprite static.ts declares — the copy can never drift behind BRAND_ASSETS', async () => {
    // static.ts's loadBrandAssets() reads exactly this set at startup; if any
    // one is missing from the copied tree the gateway throws on boot. Binding
    // the test to the real list means adding a sprite there forces it into the
    // copy, not a hand-kept duplicate that silently rots.
    await run('node', [COPY_SCRIPT, SRC_PWA, outDir])

    for (const sprite of BRAND_ASSETS) {
      expect(existsSync(join(outDir, 'brand', sprite)), sprite).toBe(true)
    }
  })

  it('copies the whole brand directory — a new source sprite ships without editing the script', async () => {
    // The script copies brand/ wholesale, so the copied set equals the source
    // set; a sprite added to src/pwa/brand appears in dist without a code change.
    await run('node', [COPY_SCRIPT, SRC_PWA, outDir])

    const sourceSprites = (await readdir(join(SRC_PWA, 'brand'))).sort()
    const copiedSprites = (await readdir(join(outDir, 'brand'))).sort()

    expect(copiedSprites).toEqual(sourceSprites)
  })
})
