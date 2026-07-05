#!/usr/bin/env node
// Launcher: prefer the compiled JS in dist/ (what ships in the npm/npx package),
// falling back to the TypeScript source via --experimental-strip-types for a dev
// checkout that hasn't built. Node refuses to strip types for files under
// node_modules, so an installed package MUST run the compiled dist/ — hence the
// build on prepare and this dist-first resolution.
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { join, dirname } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
const distEntry = join(here, '..', 'dist', 'cli', 'index.js')
const srcEntry = join(here, '..', 'src', 'cli', 'index.ts')

const useDist = existsSync(distEntry)
const args = useDist
  ? [distEntry, ...process.argv.slice(2)]
  : ['--experimental-strip-types', '--no-warnings', srcEntry, ...process.argv.slice(2)]

const child = spawn(process.execPath, args, { stdio: 'inherit' })
child.on('exit', (code) => process.exit(code ?? 1))
