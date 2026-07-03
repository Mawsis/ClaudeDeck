# ClaudeDeck — Design Decision Record

Product: ambient phone-as-deck companion + remote permission control for Claude Code.
Source spec: `claudedeck_specification.pdf` (July 2026). This document supersedes the spec
wherever they disagree — the spec contained several claims about Claude Code that do not
match the documented behavior (see "Spec corrections" below).

## Verified platform facts (docs.claude.com / code.claude.com, checked 2026-07-03)

- `http` hook handlers exist: `{ "type": "http", "url": ... }`, POST-only, JSON body identical
  to command-hook stdin. Supported fields: `headers` (with `$VAR` interpolation gated by
  `allowedEnvVars`), `timeout`.
- Blocking decisions require a **2xx response** with decision JSON. Non-2xx or timeout is a
  **non-blocking error and execution continues** — a dead gateway degrades to normal
  terminal prompting automatically.
- `PreToolUse` output schema: `hookSpecificOutput.permissionDecision: allow | deny | ask | defer`
  (+ `permissionDecisionReason`, `updatedInput`). Fires on **every** matched tool call.
- `PermissionRequest` hooks are **decision-capable**: they fire only when a permission dialog
  would actually be shown (after allowlist/mode evaluation), support the `http` handler with
  headers, receive `tool_name`/`tool_input`, and resolve the dialog by returning
  `hookSpecificOutput.decision: { behavior: "allow" | "deny", updatedInput? }`. Returning no
  decision lets the terminal dialog proceed normally.
- There is **no supported way to answer `AskUserQuestion` remotely** (hooks or Agent SDK).
- Hook timeout default for command/http hooks: **600s**, configurable per hook.
- Timer lifecycle events: `UserPromptSubmit` (turn starts) and `Stop` (turn ends) exist and
  carry `session_id`, `cwd`.
- Prior art: official **Remote Control** (`claude remote-control`, research preview since
  Feb 2026) already offers approve/monitor/steer from the Claude mobile app. ClaudeDeck's
  differentiation is the ambient, always-on, zero-launch desk deck — not remote approval itself.

## Decisions

### D1. Tenancy & hosting
Self-hosted, single-tenant, on the owner's VPS. Docker Compose behind Caddy
(automatic HTTPS/WSS via Let's Encrypt). No accounts, no pairing flow, no multi-tenant gateway.

### D2. Session model
Protocol is session-aware from day one: every event carries `session_id` and a human title
(cwd basename). The deck UI renders whichever session most recently emitted an event;
completion notifications are labeled with the session title. Multi-session dashboard is
explicitly out of MVP scope.

### D3. Interactive layer (spec §2.3)
Full remote resolution, two mechanisms:
- **Permission gates**: `PermissionRequest` http hook → gateway holds the request → deck
  renders Allow / Deny / Ask-in-terminal → gateway returns
  `decision: { behavior: "allow" | "deny" }`, or **no decision** for Ask-in-terminal (the
  dialog then renders normally). Because `PermissionRequest` fires only for dialogs that
  would actually appear, allowlisted commands stay silent and non-prompting tool calls incur
  zero hook latency. (`PreToolUse` was rejected for this path: it fires on every matched call,
  taxing allowlisted commands with redundant deck taps.)
- **Multi-choice questions**: the *deny-with-reason hack* — `PreToolUse` matcher on
  `AskUserQuestion` shows the choices on the deck, then returns
  `permissionDecision: "deny"` with `permissionDecisionReason: "User selected: <choice>"`,
  which Claude reads as the answer. **Undocumented behavior**: isolated behind its own hook
  matcher and a feature flag, occasional terminal re-asks are accepted as normal, and a canary
  integration test should run after Claude Code upgrades.

### D4. Timeout / fallback policy
Never auto-deny (supersedes spec §5's 9-minute deny valve). "Fall back" means the gateway
responds **without a decision**, letting the terminal dialog appear normally:
- No deck connected → fall back **immediately** (zero added latency, ClaudeDeck invisible).
- Deck connected but silent → fall back at **540s** (under the 600s hook default).
- Gateway unreachable → hook errors are non-blocking; terminal behaves as if ClaudeDeck
  didn't exist (verified platform behavior, no config needed).
For the `AskUserQuestion` hack (`PreToolUse`), the same policy applies with
`permissionDecision: "ask"` as the fallback response.

### D5. Interception mode
Always intercept while a deck is connected. The deck UI has a one-tap **Pause** that flips the
gateway to passthrough (instant `ask`). No arming ritual, no presence heuristics.

### D6. Phone client
Installed PWA on **Android** (Add to Home Screen). Wake Lock API keeps the docked screen
alive; `navigator.vibrate` provides the docked haptic tap; **Web Push** (service worker)
delivers alerts when the app is backgrounded or the screen is locked. No native app.

### D7. Activity ticker
`PostToolUse` (completed actions only — the ledger never lies about denied/failed calls),
registered with matcher `Write|Edit|MultiEdit|NotebookEdit|Bash` so read-only tools never
incur a hook round trip. Gateway sub-classifies Bash commands via a regex table
(package installs, migrations, docker, git push → highlighted; everything else → dim).
History is an in-memory ring buffer; no database anywhere in the system.

### D8. Transport
SSE (`EventSource`) server→phone with `Last-Event-ID` replay on reconnect; plain HTTP POSTs
phone→server for prompt resolutions. No WebSockets.

### D9. Stack
Single TypeScript service: **Hono** (Node or Bun) serving the hook API, the SSE stream, and
the static PWA (vanilla TS + service worker — no UI framework). Deployed as one container
behind Caddy.

### D10. Auth
Two scoped static tokens, long random strings in the VPS environment, rotated manually:
- `CLAUDEDECK_HOOK_TOKEN` — workstation → gateway, sent as
  `"Authorization": "Bearer $CLAUDEDECK_HOOK_TOKEN"` in hook `headers` with
  `allowedEnvVars: ["CLAUDEDECK_HOOK_TOKEN"]` (never plaintext in settings.json).
- `CLAUDEDECK_DECK_TOKEN` — phone → gateway (SSE + resolution POSTs), pasted once into
  the PWA and stored locally.
A leaked deck token cannot forge events; a leaked hook token cannot approve anything.

### D11. Alerts
Context-aware and thresholded:
- Pending permission prompts **always** alert (they block a session).
- `Stop` alerts fire only when the turn ran ≥ ~45s (configurable) — short chat turns stay silent.
- Channel by visibility: deck visible → in-page flash + vibrate; backgrounded/locked → Web Push.

### D12. Visual language (source: CCSHARE DESIGN.md + pixel Claude starburst + Clawd ASCII)
Retro 8-bit / terminal aesthetic adopted wholesale: `#0c0c0c` background, `#FF6B00` primary
accent, 4-color animation palette (`#FF6B00 #4ade80 #3b82f6 #a855f7`), hard solid borders,
`border-radius: 0` everywhere, clicky pixel buttons (hard drop-shadow compressing on press).
**Ambient-first adaptation** for the always-on OLED: idle and running states render dim
(~35–45% luminance, desaturated), the whole layout pixel-shifts a few px every minute
(burn-in protection), and nothing sits at full brightness statically. Full-saturation color and
CRT effects are reserved for prompt arrival and done-alerts.

### D13. Typography
Three tiers: **Press Start 2P** for clock digits, headers, and button labels; **VT323** for
ticker lines and secondary chrome; a **crisp real monospace** (JetBrains Mono or IBM Plex
Mono) exclusively for `tool_input` payloads on approval cards — commands, paths, and diffs
must be legible and glyph-unambiguous where misreading has consequences.

### D14. State system & mascot
One accent per deck state, readable from peripheral vision:
dim white = idle · orange = session running · green = done flash · yellow = prompt pending
(takeover) · purple = paused · gray + scanline static = gateway disconnected.
**Clawd is the live state indicator**: sleeping (idle), typing/bobbing (running), waving (done),
alarmed (prompt), corner placement.

### D15. Approval touch model
Asymmetric friction — accidental contact can only produce safe outcomes on a desk-exposed
screen: **Deny** and **Ask-in-terminal** are single taps; **Allow** is hold-to-fill (~500ms,
pixel-art charge bar), with a longer hold for commands the gateway's regex table classifies as
high-risk (rm, force-push, migrations, deploys).

### D16. Layout
**Landscape-primary** desk-clock layout: large digits across the width, Clawd in a corner,
ticker as a bottom strip, approval card as full-screen takeover with side-by-side actions.
Portrait is a functional but unpolished fallback.

### D17. Motion budget
Idle is near-still: Clawd blink (~30s), 1Hz colon pulse, minute pixel-shift. State changes get
one stripe-wipe under 600ms. The running state's only loop is Clawd typing; ticker rows slide
in over 150ms. The full CCSHARE multi-stripe CRT choreography fires on exactly one event —
permission prompt arrival. Done = green boundary flash + Clawd wave, then stillness.
No continuous float loops.

### D18. Branding
Public repo ships the pixel Claude starburst and Clawd as-is (trademark exposure understood
and accepted). Hedge: all brand assets live in one swappable `brand/` directory referenced by
token, so a forced rebrand is an asset swap, not a refactor.

## Settled by design (no open question)

- Session timer: `UserPromptSubmit` starts, `Stop` freezes + alerts. `SubagentStop` is ignored
  (subagent churn would strobe the clock).
- `permissions.defaultMode` stays `"default"`. The spec's `dontAsk` recommendation is dropped:
  wrong key name, and it removes the terminal fallback this design depends on.
- Concurrent prompts (any sessions): FIFO queue on the deck, one rendered at a time,
  queue-depth badge.
- Approval surfaces always show `tool_name` and the salient `tool_input` (command text,
  file path) — no blind approvals.
- All ClaudeDeck state is in-memory; a gateway restart loses only ticker history and any
  pending prompt (which then falls back per D4).

## Spec corrections

| Spec claim | Reality |
|---|---|
| Hook output `"selected_choice"` answers a question | Fiction — no mechanism exists; replaced by deny-with-reason hack (D3) |
| `PermissionRequest` output uses `permissionDecision` | Real event, wrong schema — it returns `decision: { behavior: "allow" \| "deny" }`; it is the right interception point and drives D3 |
| 9-minute timeout → auto-`deny` | Auto-deny injects a fake refusal mid-task; replaced with `ask` fallback (D4) |
| `"defaultPermissionMode": "dontAsk"` | Wrong key (`permissions.defaultMode`); mode dropped entirely |
| Hook timeout "extended to 10 minutes in v2.1.x" | 600s is simply the configurable default for command/http hooks |
| `navigator.vibrate` haptic | Dead on iOS Safari; fine on the chosen Android PWA (D6) |
| "Short-lived cryptographically signed keys" | Two scoped static tokens (D10); short-lived tokens would dark the docked deck on expiry |

## Open items

None. (PermissionRequest decision capability was verified against the docs — it can resolve
dialogs and fires only for genuine prompts — and D3/D4 were updated accordingly.)

## Revised MVP release map

| Phase | Scope | Deliverables |
|---|---|---|
| 1 | Gateway skeleton | Hono service (event ingest, SSE stream, token middleware), Docker + Caddy deploy on VPS, hook config generator, PWA shell with idle clock |
| 2 | Ambient core | `UserPromptSubmit`/`Stop` timer states, `PostToolUse` ticker + Bash classifier, alert engine (flash/vibrate/Web Push, 45s threshold), session labeling, themed UI (D12–D14, D16–D17: dim ambient states, Clawd indicator, landscape clock) |
| 3 | Interactive | `PermissionRequest` interception UI (Allow/Deny/Ask-in-terminal, hold-to-Allow per D15, prompt-arrival choreography per D17), Pause toggle, 540s no-decision fallback, FIFO prompt queue, AskUserQuestion hack (`PreToolUse`) behind feature flag + canary test |
