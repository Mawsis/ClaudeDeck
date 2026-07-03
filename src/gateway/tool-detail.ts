const MAX_DETAIL_LENGTH = 200
/** Approval cards show the exact payload (D3) — room for real heredocs and
 * diffs, while still bounding the SSE frame a hostile payload could balloon. */
const MAX_PERMISSION_DETAIL_LENGTH = 4_000

/**
 * `slice()` counts UTF-16 units and can cut a surrogate pair in half, leaving
 * a broken glyph on the deck — clamp on code points instead. The unit-level
 * pre-slice keeps `Array.from` off pathologically long commands; the +1 spare
 * unit covers the worst case of the cap landing inside the last pair.
 */
function clampCodePoints(text: string, max: number): string {
  if (text.length <= max) return text
  return Array.from(text.slice(0, max * 2 + 1))
    .slice(0, max)
    .join('')
}

/** Ticker-sized: one strip row, or a push notification body. */
export function clampDetail(text: string): string {
  return clampCodePoints(text, MAX_DETAIL_LENGTH)
}

/**
 * The one-liner the ticker shows for a tool call: the command for Bash, the
 * touched file for edit tools — relative to the session's cwd, since the row
 * already carries the session label. Best-effort — an unrecognized input
 * shape yields an empty detail rather than dropping the audit row.
 */
export function extractToolDetail(toolInput: unknown, cwd: string): string {
  if (typeof toolInput !== 'object' || toolInput === null) return ''
  const record = toolInput as Record<string, unknown>
  if (typeof record.command === 'string' && record.command !== '') return record.command
  for (const key of ['file_path', 'notebook_path']) {
    const value = record[key]
    if (typeof value === 'string' && value !== '') {
      return value.startsWith(`${cwd}/`) ? value.slice(cwd.length + 1) : value
    }
  }
  return ''
}

/**
 * What the approval card shows (D3: no blind approvals): the salient command
 * or path when the shape is known, otherwise the whole `tool_input` as JSON —
 * an unrecognized tool must never present an empty payload for approval.
 */
export function permissionDetail(toolInput: unknown, cwd: string): string {
  const salient = extractToolDetail(toolInput, cwd)
  const exact = salient !== '' ? salient : toolInput === undefined ? '' : (JSON.stringify(toolInput) ?? '')
  if (exact.length <= MAX_PERMISSION_DETAIL_LENGTH) return exact
  // The cut must be visible: an approval of a silently shortened command
  // would be an approval of something the user never saw.
  return `${clampCodePoints(exact, MAX_PERMISSION_DETAIL_LENGTH)}… [truncated]`
}
