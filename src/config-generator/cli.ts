import { pathToFileURL } from 'node:url'
import { generateHookSettings } from './generate.ts'

const USAGE = 'usage: npm run generate-config -- --gateway-url https://your-deck-host'

export function renderCliOutput(argv: readonly string[]): string {
  const flagIndex = argv.indexOf('--gateway-url')
  const gatewayUrl = flagIndex === -1 ? undefined : argv[flagIndex + 1]
  if (gatewayUrl === undefined || gatewayUrl.startsWith('--')) {
    throw new Error(USAGE)
  }
  return JSON.stringify(generateHookSettings({ gatewayUrl }), null, 2)
}

const invokedDirectly = process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href
if (invokedDirectly) {
  try {
    console.log(renderCliOutput(process.argv.slice(2)))
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error))
    process.exit(1)
  }
}
