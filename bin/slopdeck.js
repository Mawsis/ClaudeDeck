#!/usr/bin/env node
// Thin launcher: the CLI itself is TypeScript run via --experimental-strip-types,
// and a bin script cannot set node flags for its own process — so re-exec.
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { join, dirname } from 'node:path'

const cliPath = join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'cli', 'index.ts')
const child = spawn(
  process.execPath,
  ['--experimental-strip-types', '--no-warnings', cliPath, ...process.argv.slice(2)],
  { stdio: 'inherit' },
)
child.on('exit', (code) => process.exit(code ?? 1))
