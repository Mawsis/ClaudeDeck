import { describe, expect, it } from 'vitest'
import { generateHookSettings, HOOK_TOKEN_ENV_VAR } from '../src/config-generator/generate.ts'
import {
  addHookSettings,
  addZshrcBlock,
  hookTokenFromSettings,
  removeHookSettings,
  removeZshrcBlock,
  setHookToken,
} from '../src/cli/settings-surgeon.ts'

const GATEWAY = 'https://deck.example.com'
const slopdeckHooks = generateHookSettings({ gatewayUrl: GATEWAY })
const TOKEN = 'hook-token-abc123'

describe('Claude settings surgery', () => {
  it('installs the hook block into an empty settings file', () => {
    const result = addHookSettings('', slopdeckHooks, TOKEN)

    expect(result.ok).toBe(true)
    if (!result.ok) return
    const parsed = JSON.parse(result.content)
    expect(parsed.hooks.Stop).toHaveLength(1)
    expect(parsed.hooks.Stop[0].hooks[0].url).toBe(`${GATEWAY}/api/events`)
    expect(parsed.hooks.PermissionRequest[0].hooks[0].url).toBe(`${GATEWAY}/api/permission`)
  })

  it('merges alongside foreign hooks and settings keys without touching them', () => {
    const existing = JSON.stringify({
      model: 'opus',
      hooks: {
        Stop: [{ hooks: [{ type: 'command', command: 'say done' }] }],
        PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'lint.sh' }] }],
      },
    })

    const result = addHookSettings(existing, slopdeckHooks, TOKEN)

    expect(result.ok).toBe(true)
    if (!result.ok) return
    const parsed = JSON.parse(result.content)
    expect(parsed.model).toBe('opus')
    // The foreign Stop hook keeps its slot; slopdeck's is appended after it.
    expect(parsed.hooks.Stop).toHaveLength(2)
    expect(parsed.hooks.Stop[0]).toEqual({ hooks: [{ type: 'command', command: 'say done' }] })
    expect(parsed.hooks.PreToolUse).toHaveLength(1)
  })

  it('is idempotent: re-installing (even against a different gateway) replaces, never stacks', () => {
    const first = addHookSettings('', generateHookSettings({ gatewayUrl: 'https://old.example.com' }), TOKEN)
    if (!first.ok) throw new Error('unreachable')

    const second = addHookSettings(first.content, slopdeckHooks, TOKEN)

    expect(second.ok).toBe(true)
    if (!second.ok) return
    const parsed = JSON.parse(second.content)
    expect(parsed.hooks.Stop).toHaveLength(1)
    expect(JSON.stringify(parsed)).not.toContain('old.example.com')
  })

  it('uninstall removes exactly the slopdeck entries — install-then-uninstall is a semantic identity round trip', () => {
    const existing = JSON.stringify({
      model: 'opus',
      hooks: {
        Stop: [{ hooks: [{ type: 'command', command: 'say done' }] }],
      },
    })
    const installed = addHookSettings(existing, slopdeckHooks, TOKEN)
    if (!installed.ok) throw new Error('unreachable')

    const removed = removeHookSettings(installed.content)

    expect(removed.ok).toBe(true)
    if (!removed.ok) return
    expect(JSON.parse(removed.content)).toEqual(JSON.parse(existing))
  })

  it('round-trips arbitrary pre-existing settings shapes (seeded property sweep)', () => {
    // Deterministic LCG — a property sweep the suite can replay exactly.
    let seed = 42
    const rand = () => (seed = (seed * 1_103_515_245 + 12_345) % 2 ** 31) / 2 ** 31
    const pick = <T>(items: readonly T[]) => items[Math.floor(rand() * items.length)]!

    for (let round = 0; round < 50; round++) {
      const foreign: Record<string, unknown> = {}
      if (rand() > 0.3) foreign.model = pick(['opus', 'sonnet', 'haiku'])
      if (rand() > 0.5) foreign.permissions = { allow: [pick(['Bash(ls:*)', 'Read'])] }
      if (rand() > 0.4) {
        foreign.hooks = Object.fromEntries(
          [...new Set([pick(['Stop', 'PreToolUse', 'PostToolUse', 'SessionStart']), pick(['Stop', 'UserPromptSubmit'])])].map(
            (hookEvent) => [
              hookEvent,
              [{ matcher: pick(['Bash', 'Write|Edit', undefined]), hooks: [{ type: 'command', command: `cmd-${Math.floor(rand() * 100)}` }] }].map(
                (entry) => (entry.matcher === undefined ? { hooks: entry.hooks } : entry),
              ),
            ],
          ),
        )
      }
      const original = JSON.stringify(foreign)

      const installed = addHookSettings(original, slopdeckHooks, TOKEN)
      expect(installed.ok).toBe(true)
      if (!installed.ok) return
      const removed = removeHookSettings(installed.content)
      expect(removed.ok).toBe(true)
      if (!removed.ok) return

      expect(JSON.parse(removed.content)).toEqual(JSON.parse(original))
    }
  })

  it('removing from settings that never had slopdeck changes nothing', () => {
    const existing = JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: 'command', command: 'x' }] }] } })

    const removed = removeHookSettings(existing)

    expect(removed.ok).toBe(true)
    if (!removed.ok) return
    expect(JSON.parse(removed.content)).toEqual(JSON.parse(existing))
  })

  it('rejects malformed settings JSON with a typed error — never a partial rewrite', () => {
    expect(addHookSettings('{not json', slopdeckHooks, TOKEN).ok).toBe(false)
    expect(removeHookSettings('{not json').ok).toBe(false)
    expect(addHookSettings('[1,2,3]', slopdeckHooks, TOKEN).ok).toBe(false)
    expect(addHookSettings('"just a string"', slopdeckHooks, TOKEN).ok).toBe(false)
  })
})

describe('hook token in the settings env block (cross-platform)', () => {
  it('writes the token into env so Claude Code injects it into hooks on every OS', () => {
    const result = addHookSettings('', slopdeckHooks, TOKEN)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    const parsed = JSON.parse(result.content)
    expect(parsed.env[HOOK_TOKEN_ENV_VAR]).toBe(TOKEN)
    expect(hookTokenFromSettings(result.content)).toBe(TOKEN)
  })

  it('preserves foreign env vars while setting the token', () => {
    const existing = JSON.stringify({ env: { FOO: 'bar' } })
    const result = addHookSettings(existing, slopdeckHooks, TOKEN)
    if (!result.ok) throw new Error('unreachable')
    const parsed = JSON.parse(result.content)
    expect(parsed.env.FOO).toBe('bar')
    expect(parsed.env[HOOK_TOKEN_ENV_VAR]).toBe(TOKEN)
  })

  it('uninstall strips the slopdeck token but leaves foreign env vars', () => {
    const existing = JSON.stringify({ env: { FOO: 'bar' } })
    const installed = addHookSettings(existing, slopdeckHooks, TOKEN)
    if (!installed.ok) throw new Error('unreachable')
    const removed = removeHookSettings(installed.content)
    if (!removed.ok) throw new Error('unreachable')
    const parsed = JSON.parse(removed.content)
    expect(parsed.env).toEqual({ FOO: 'bar' })
    expect(hookTokenFromSettings(removed.content)).toBeUndefined()
  })

  it('drops the env key entirely when the slopdeck token was its only entry', () => {
    const installed = addHookSettings('', slopdeckHooks, TOKEN)
    if (!installed.ok) throw new Error('unreachable')
    const removed = removeHookSettings(installed.content)
    if (!removed.ok) throw new Error('unreachable')
    expect(JSON.parse(removed.content).env).toBeUndefined()
  })

  it('setHookToken re-keys the token in place without touching hooks (rotate)', () => {
    const installed = addHookSettings('', slopdeckHooks, TOKEN)
    if (!installed.ok) throw new Error('unreachable')
    const rotated = setHookToken(installed.content, 'fresh-token-xyz')
    if (!rotated.ok) throw new Error('unreachable')
    const parsed = JSON.parse(rotated.content)
    expect(parsed.env[HOOK_TOKEN_ENV_VAR]).toBe('fresh-token-xyz')
    // Hooks are untouched by a token rotation.
    expect(parsed.hooks.Stop).toHaveLength(1)
  })

  it('hookTokenFromSettings returns undefined when no token is present or content is malformed', () => {
    expect(hookTokenFromSettings('{}')).toBeUndefined()
    expect(hookTokenFromSettings('{not json')).toBeUndefined()
    expect(hookTokenFromSettings(JSON.stringify({ env: { FOO: 'bar' } }))).toBeUndefined()
  })
})

describe('zshrc block surgery', () => {
  it('appends a marked export block holding the hook token', () => {
    const result = addZshrcBlock('# my zshrc\nalias ll="ls -l"\n', 'tok-123')

    expect(result).toContain('# my zshrc\nalias ll="ls -l"\n')
    expect(result).toContain(">>> slopdeck")
    expect(result).toContain("export SLOPDECK_HOOK_TOKEN='tok-123'")
    expect(result).toContain('<<< slopdeck')
  })

  it('removes exactly the marked block — add-then-remove is byte-identical, foreign lines untouched', () => {
    const original = '# my zshrc\nexport PATH="$PATH:/opt/bin"\nalias ll="ls -l"\n'

    expect(removeZshrcBlock(addZshrcBlock(original, 'tok-123'))).toBe(original)
  })

  it('round-trips content that lacks a trailing newline', () => {
    const original = 'alias ll="ls -l"'

    expect(removeZshrcBlock(addZshrcBlock(original, 'tok-123'))).toBe(original)
  })

  it('replaces a stale block on re-install instead of stacking a second one', () => {
    const first = addZshrcBlock('# zshrc\n', 'old-token')
    const second = addZshrcBlock(first, 'new-token')

    expect(second).toContain("export SLOPDECK_HOOK_TOKEN='new-token'")
    expect(second).not.toContain('old-token')
    expect(second.match(/>>> slopdeck/g)).toHaveLength(1)
  })

  it('leaves a zshrc without any slopdeck block untouched on remove', () => {
    const original = '# untouched\nexport FOO=bar\n'

    expect(removeZshrcBlock(original)).toBe(original)
  })

  it('quotes a token containing single quotes so the export line cannot break out', () => {
    const result = addZshrcBlock('', "to'ken")

    // POSIX single-quote escaping: close, escaped quote, reopen.
    expect(result).toContain("export SLOPDECK_HOOK_TOKEN='to'\\''ken'")
  })
})
