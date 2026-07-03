import { describe, expect, it } from 'vitest'
import { generateHookSettings } from '../src/config-generator/generate.ts'

describe('config generator', () => {
  it('registers a Stop http hook pointed at the gateway ingest route', () => {
    const settings = generateHookSettings({ gatewayUrl: 'https://deck.example.com' })

    const stopMatchers = settings.hooks.Stop
    expect(stopMatchers).toHaveLength(1)
    const hook = stopMatchers[0]!.hooks[0]!
    expect(hook.type).toBe('http')
    expect(hook.url).toBe('https://deck.example.com/api/events')
  })

  it('sends the workstation secret only as env-var interpolation gated by allowedEnvVars', () => {
    const settings = generateHookSettings({ gatewayUrl: 'https://deck.example.com' })

    const hook = settings.hooks.Stop[0]!.hooks[0]!
    expect(hook.headers.Authorization).toBe('Bearer $CLAUDEDECK_HOOK_TOKEN')
    expect(settings.allowedEnvVars).toContain('CLAUDEDECK_HOOK_TOKEN')
  })

  it('normalizes a trailing slash on the gateway url', () => {
    const settings = generateHookSettings({ gatewayUrl: 'https://deck.example.com/' })

    expect(settings.hooks.Stop[0]!.hooks[0]!.url).toBe('https://deck.example.com/api/events')
  })

  it('rejects a non-http(s) gateway url', () => {
    expect(() => generateHookSettings({ gatewayUrl: 'ftp://deck.example.com' })).toThrow(/http/)
    expect(() => generateHookSettings({ gatewayUrl: 'not a url' })).toThrow()
  })
})
