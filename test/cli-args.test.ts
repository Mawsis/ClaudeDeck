import { describe, expect, it } from 'vitest'
import { parseCliArgs } from '../src/cli/index.ts'

describe('CLI argument parsing', () => {
  it('parses install with an optional --gateway-url flag', () => {
    expect(parseCliArgs(['install'])).toEqual({ command: 'install', gatewayUrl: undefined })
    expect(parseCliArgs(['install', '--gateway-url', 'https://d.example.com'])).toEqual({
      command: 'install',
      gatewayUrl: 'https://d.example.com',
    })
  })

  it('parses uninstall', () => {
    expect(parseCliArgs(['uninstall'])).toEqual({ command: 'uninstall', gatewayUrl: undefined })
  })

  it('rejects unknown or missing commands and a dangling flag', () => {
    expect(parseCliArgs([])).toBeNull()
    expect(parseCliArgs(['frobnicate'])).toBeNull()
    expect(parseCliArgs(['install', '--gateway-url'])).toBeNull()
    expect(parseCliArgs(['install', '--gateway-url', '--other'])).toBeNull()
  })
})
