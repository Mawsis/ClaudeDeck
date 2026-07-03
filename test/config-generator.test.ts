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

  it('registers a UserPromptSubmit http hook with the same ingest url and env-var auth header', () => {
    const settings = generateHookSettings({ gatewayUrl: 'https://deck.example.com' })

    const promptMatchers = settings.hooks.UserPromptSubmit
    expect(promptMatchers).toHaveLength(1)
    const hook = promptMatchers[0]!.hooks[0]!
    expect(hook.type).toBe('http')
    expect(hook.url).toBe('https://deck.example.com/api/events')
    expect(hook.headers.Authorization).toBe('Bearer $CLAUDEDECK_HOOK_TOKEN')
  })

  it('registers a PostToolUse http hook gated to write-capable tools only', () => {
    const settings = generateHookSettings({ gatewayUrl: 'https://deck.example.com' })

    const postToolUseMatchers = settings.hooks.PostToolUse
    expect(postToolUseMatchers).toHaveLength(1)
    const { matcher, hooks } = postToolUseMatchers[0]!
    expect(hooks[0]!.url).toBe('https://deck.example.com/api/events')
    expect(hooks[0]!.headers.Authorization).toBe('Bearer $CLAUDEDECK_HOOK_TOKEN')

    // Read-only tools must never incur a hook round trip (issue #5 / D7):
    // the matcher regex may name only write-capable tools.
    const asRegex = new RegExp(`^(?:${matcher!})$`)
    for (const writeTool of ['Write', 'Edit', 'MultiEdit', 'NotebookEdit', 'Bash']) {
      expect(asRegex.test(writeTool), `${writeTool} should match`).toBe(true)
    }
    for (const readOnlyTool of ['Read', 'Grep', 'Glob', 'WebFetch', 'WebSearch', 'TodoWrite']) {
      expect(asRegex.test(readOnlyTool), `${readOnlyTool} should not match`).toBe(false)
    }
  })

  it('registers a PermissionRequest http hook pointed at the permission hold route', () => {
    const settings = generateHookSettings({ gatewayUrl: 'https://deck.example.com' })

    // D3: PermissionRequest, not PreToolUse — it fires only when a dialog
    // would genuinely appear, so allowlisted commands never reach the deck.
    const permissionMatchers = settings.hooks.PermissionRequest
    expect(permissionMatchers).toHaveLength(1)
    const hook = permissionMatchers[0]!.hooks[0]!
    expect(hook.type).toBe('http')
    expect(hook.url).toBe('https://deck.example.com/api/permission')
    expect(hook.headers.Authorization).toBe('Bearer $CLAUDEDECK_HOOK_TOKEN')
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
