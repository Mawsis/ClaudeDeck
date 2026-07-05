import { HOOK_TOKEN_ENV_VAR, type HookSettings } from '../config-generator/generate.ts'

/**
 * settings-surgeon: pure functions over file *content* — it never does I/O.
 * Every mutation is surgical add-or-exact-remove of slopdeck's own entries,
 * identified by marker comments (.zshrc) or the `$SLOPDECK_HOOK_TOKEN`
 * Authorization header (Claude settings). Restoration is removal, never
 * snapshot-restore: a snapshot would clobber user edits made after install.
 */

export type SurgeonResult =
  | { readonly ok: true; readonly content: string }
  | { readonly ok: false; readonly error: string }

/** slopdeck's fingerprint in Claude settings: every hook we ever write
 * authorizes via the `$SLOPDECK_HOOK_TOKEN` interpolation form — no user-
 * authored hook has a reason to reference it. Gateway-URL-independent, so a
 * re-install pointed at a new gateway still finds the old entries. */
function isSlopdeckMatcher(entry: unknown): boolean {
  if (typeof entry !== 'object' || entry === null) return false
  const hooks = (entry as Record<string, unknown>).hooks
  if (!Array.isArray(hooks) || hooks.length === 0) return false
  return hooks.every((hook) => {
    if (typeof hook !== 'object' || hook === null) return false
    const headers = (hook as Record<string, unknown>).headers
    if (typeof headers !== 'object' || headers === null) return false
    const authorization = (headers as Record<string, unknown>).Authorization
    return typeof authorization === 'string' && authorization.includes(`$${HOOK_TOKEN_ENV_VAR}`)
  })
}

function parseSettingsObject(content: string): Record<string, unknown> | null {
  const trimmed = content.trim()
  if (trimmed === '') return {}
  let parsed: unknown
  try {
    parsed = JSON.parse(trimmed)
  } catch {
    return null
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null
  return parsed as Record<string, unknown>
}

/** Strip slopdeck matchers out of a parsed settings object — returns a new
 * object; arrays and keys emptied by the strip are dropped entirely. */
function stripSlopdeckHooks(settings: Record<string, unknown>): Record<string, unknown> {
  const hooks = settings.hooks
  if (typeof hooks !== 'object' || hooks === null || Array.isArray(hooks)) return settings
  const remaining = Object.fromEntries(
    Object.entries(hooks as Record<string, unknown>)
      .map(([hookEvent, matchers]) => [
        hookEvent,
        Array.isArray(matchers) ? matchers.filter((entry) => !isSlopdeckMatcher(entry)) : matchers,
      ])
      .filter(([, matchers]) => !(Array.isArray(matchers) && matchers.length === 0)),
  )
  const { hooks: _removed, ...rest } = settings
  return Object.keys(remaining).length === 0 ? rest : { ...rest, hooks: remaining }
}

/** Whether settings content carries any slopdeck hook entry — the `status`
 * command's "hooks installed" chain link. Malformed content is simply "no". */
export function hasSlopdeckHooks(content: string): boolean {
  const settings = parseSettingsObject(content)
  if (settings === null) return false
  const hooks = settings.hooks
  if (typeof hooks !== 'object' || hooks === null || Array.isArray(hooks)) return false
  return Object.values(hooks as Record<string, unknown>).some(
    (matchers) => Array.isArray(matchers) && matchers.some(isSlopdeckMatcher),
  )
}

/**
 * Merge slopdeck's hook matchers into Claude settings content. Foreign
 * matchers and settings keys pass through untouched; any prior slopdeck
 * entries (even for another gateway) are replaced, never stacked. Malformed
 * input is a typed error — the caller must not write anything.
 */
export function addHookSettings(content: string, hookSettings: HookSettings): SurgeonResult {
  const settings = parseSettingsObject(content)
  if (settings === null) {
    return { ok: false, error: 'settings file is not a JSON object — refusing to touch it' }
  }
  const cleaned = stripSlopdeckHooks(settings)
  const existingHooks =
    typeof cleaned.hooks === 'object' && cleaned.hooks !== null && !Array.isArray(cleaned.hooks)
      ? (cleaned.hooks as Record<string, unknown>)
      : {}
  const merged = { ...existingHooks }
  for (const [hookEvent, matchers] of Object.entries(hookSettings.hooks)) {
    if (matchers === undefined) continue
    const present = merged[hookEvent]
    merged[hookEvent] = Array.isArray(present) ? [...present, ...matchers] : [...matchers]
  }
  return { ok: true, content: JSON.stringify({ ...cleaned, hooks: merged }, null, 2) + '\n' }
}

/**
 * Remove exactly the slopdeck entries. Surgical removal, never
 * snapshot-restore — user edits made after install must survive.
 */
export function removeHookSettings(content: string): SurgeonResult {
  const settings = parseSettingsObject(content)
  if (settings === null) {
    return { ok: false, error: 'settings file is not a JSON object — refusing to touch it' }
  }
  return { ok: true, content: JSON.stringify(stripSlopdeckHooks(settings), null, 2) + '\n' }
}

export const ZSHRC_BEGIN_MARKER = '# >>> slopdeck hook token >>>'
export const ZSHRC_END_MARKER = '# <<< slopdeck hook token <<<'

/** POSIX single-quote escaping: close the quote, emit an escaped one, reopen. */
function shellSingleQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`
}

/**
 * Append the marked export block. Any stale block is replaced, never stacked —
 * the block is the only place the hook token is ever stored.
 */
export function addZshrcBlock(content: string, hookToken: string): string {
  const stripped = removeZshrcBlock(content)
  const block = `${ZSHRC_BEGIN_MARKER}\nexport ${HOOK_TOKEN_ENV_VAR}=${shellSingleQuote(hookToken)}\n${ZSHRC_END_MARKER}\n`
  return `${stripped}\n${block}`
}

/**
 * Remove exactly the marked block (markers, contents, and the blank line the
 * add introduced). Content without a block passes through byte-identical.
 */
export function removeZshrcBlock(content: string): string {
  const begin = content.indexOf(ZSHRC_BEGIN_MARKER)
  if (begin === -1) return content
  const endMarker = content.indexOf(ZSHRC_END_MARKER, begin)
  if (endMarker === -1) return content
  let end = endMarker + ZSHRC_END_MARKER.length
  if (content[end] === '\n') end += 1
  // The add prefixed the block with one separating newline — take it back too.
  const start = begin > 0 && content[begin - 1] === '\n' ? begin - 1 : begin
  return content.slice(0, start) + content.slice(end)
}
