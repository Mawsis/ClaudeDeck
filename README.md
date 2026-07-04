# ClaudeDeck

Ambient phone-as-deck companion + remote permission control for Claude Code.
Design record: [DECISIONS.md](DECISIONS.md).

Current state: **ambient session clock that never lies** — Claude Code
`UserPromptSubmit` and `Stop` hooks POST to the gateway, which streams them
over SSE to the PWA. The deck is a landscape desk clock: time of day while
idle, an incrementing session timer from the moment a prompt is submitted,
frozen on Stop — labeled with the session's directory name. Events are
server-timestamped and replayed from the ring buffer on reconnect
(`Last-Event-ID`), so a network blip never leaves the deck stale; while the
stream is down the deck shows an unmistakable gray scanline OFFLINE state.
Idle/running render dim for the always-on OLED, and the layout pixel-shifts
every minute against burn-in. Wake Lock keeps the docked screen alive.

Below the clock runs the **activity ticker**: `PostToolUse` hooks (registered
only for `Write|Edit|MultiEdit|NotebookEdit|Bash`, so reads never pay a hook
round trip) feed a bounded audit strip. A table-driven classifier highlights
high-impact Bash commands (installs, migrations, docker, pushes, deploys);
everything else renders as a dim one-liner.

**Completion alerts** stay meaningful: the shared reducer decides them, and a
`Stop` alerts only when the turn ran at least the threshold (45s default,
`CLAUDEDECK_ALERT_THRESHOLD_MS` to change) — short chat turns stay silent.
Channel follows visibility: a visible deck gets a green boundary flash and a
vibration tap; a backgrounded or locked phone gets a Web Push notification
carrying the session title (enable by setting the VAPID variables from
`deploy/.env.example` — without them, only in-page alerts fire).

**Approve or deny from the deck**: a `PermissionRequest` http hook — it fires
only when a permission dialog would genuinely appear, so allowlisted commands
never reach the deck — POSTs to `/api/permission`, and the gateway holds the
request open while the deck takes over the screen: tool name plus the exact
command/path payload in real monospace, with **Allow**, **Deny**, and
**Ask-in-terminal** taps. Allow/Deny answer the hook with the documented
decision JSON; Ask-in-terminal — and every fallback — returns *no decision*,
letting the terminal dialog proceed normally. Fallbacks never auto-deny:
immediately when no deck is connected, at 540s (under the 600s hook timeout)
when a connected deck stays silent. Prompt arrival always alerts (takeover +
vibration in view, Web Push otherwise), and prompts queue FIFO, oldest first.

**Pause** is one tap, no arming ritual: it flips the gateway to passthrough, and
while paused every `PermissionRequest` falls back to the terminal instantly —
no hold, no card. The mode broadcasts as its own SSE event (replayed on
reconnect) and is reported by `/api/deck-config`, so a reloaded deck comes back
with the right accent; the deck tints purple while paused (D14). Tapping again
resumes interception.

**Answer Claude's questions remotely** (opt-in): with `--intercept-questions`,
the config generator additionally registers a `PreToolUse` http hook matched to
`AskUserQuestion` alone. The gateway holds the call, the deck renders the
question with one tap-target per choice (plus an Ask-in-terminal escape), and
the tapped choice returns as `permissionDecision: "deny"` with reason
`User selected: <choice>` — which Claude reads as the answer. Every fallback
(no deck, pause, 540s silence, unrecognized payload shape) returns
`permissionDecision: "ask"` so the question renders in the terminal normally.
This rides on **undocumented behavior**, so it ships behind its own flag and
hook matcher, and occasional terminal re-asks are expected, not bugs.

Because the mechanism is undocumented, a **canary test** drives a real Claude
Code session end-to-end (deck taps a choice → session proceeds with it). Run it
on demand — especially after upgrading Claude Code:

```bash
npm run canary    # needs working Claude Code credentials; consumes tokens
```

A failure where the session ignores the deny reason (the canary's `canUseTool`
detector fires) means the hack broke in a Claude Code update — disable
`--intercept-questions` until it's revalidated.

## Develop

```bash
npm install
npm test                 # vitest suite (unit + e2e tracer)
npm run typecheck
CLAUDEDECK_HOOK_TOKEN=$(openssl rand -hex 32) \
CLAUDEDECK_DECK_TOKEN=$(openssl rand -hex 32) \
npm run dev              # gateway + PWA on :8484
```

## Deploy (VPS)

```bash
cp deploy/.env.example deploy/.env   # fill in tokens + DECK_DOMAIN
cd deploy && docker compose up -d --build
```

Caddy provisions HTTPS for `DECK_DOMAIN` automatically. All gateway state is
in memory — restarting loses only event history.

## Wire up the workstation

```bash
npm run generate-config -- --gateway-url https://your-deck-domain
# add --intercept-questions to opt into the AskUserQuestion hack
```

Merge the printed JSON into `~/.claude/settings.json`, export
`CLAUDEDECK_HOOK_TOKEN` in your shell, and open the gateway URL on the phone —
paste the deck token once when prompted.
