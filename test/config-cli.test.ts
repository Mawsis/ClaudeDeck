import { describe, expect, it } from 'vitest'
import { renderCliOutput } from '../src/config-generator/cli.ts'

describe('config generator CLI', () => {
  it('prints the settings JSON for a gateway url', () => {
    const output = renderCliOutput(['--gateway-url', 'https://deck.example.com'])

    const parsed = JSON.parse(output)
    expect(parsed.hooks.Stop[0].hooks[0].url).toBe('https://deck.example.com/api/events')
    expect(parsed.hooks.Stop[0].hooks[0].allowedEnvVars).toEqual(['CLAUDEDECK_HOOK_TOKEN'])
    expect(output).not.toContain('Bearer sk')
    expect(output).toContain('$CLAUDEDECK_HOOK_TOKEN')
  })

  it('omits PreToolUse without the flag and registers it with --intercept-questions', () => {
    const withoutFlag = JSON.parse(renderCliOutput(['--gateway-url', 'https://deck.example.com']))
    expect(withoutFlag.hooks).not.toHaveProperty('PreToolUse')

    const withFlag = JSON.parse(
      renderCliOutput(['--gateway-url', 'https://deck.example.com', '--intercept-questions']),
    )
    expect(withFlag.hooks.PreToolUse[0].matcher).toBe('AskUserQuestion')
    expect(withFlag.hooks.PreToolUse[0].hooks[0].url).toBe('https://deck.example.com/api/question')
  })

  it('fails with a usage message when --gateway-url is missing', () => {
    expect(() => renderCliOutput([])).toThrow(/--gateway-url/)
  })
})
