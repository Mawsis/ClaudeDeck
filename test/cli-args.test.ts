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

  it('parses the remote-control and pairing commands: on, off, status, qr, rotate', () => {
    for (const command of ['on', 'off', 'status', 'qr', 'rotate'] as const) {
      expect(parseCliArgs([command])).toEqual({ command, gatewayUrl: undefined })
    }
  })

  it('never accepts a key via argv on rotate — an extra argument is a usage error', () => {
    expect(parseCliArgs(['rotate', 'some-key'])).toBeNull()
  })

  it('never accepts a token via argv — an unexpected extra argument is a usage error', () => {
    expect(parseCliArgs(['on', 'some-deck-token'])).toBeNull()
    expect(parseCliArgs(['qr', '--deck-token', 'x'])).toBeNull()
  })

  it('rejects unknown or missing commands and a dangling flag', () => {
    expect(parseCliArgs([])).toBeNull()
    expect(parseCliArgs(['frobnicate'])).toBeNull()
    expect(parseCliArgs(['install', '--gateway-url'])).toBeNull()
    expect(parseCliArgs(['install', '--gateway-url', '--other'])).toBeNull()
  })
})
