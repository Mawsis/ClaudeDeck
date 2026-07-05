# slopdeck

Ambient phone-as-deck companion + remote permission control for Claude Code.
An old phone docked on the desk becomes a live deck: session clock, activity
ticker, completion alerts — and the place where you approve permission
prompts and answer Claude's questions without touching the terminal.
Design record: [DECISIONS.md](DECISIONS.md).

## What the deck does

**A session clock that never lies.** Claude Code `UserPromptSubmit` and `Stop`
hooks POST to the gateway, which streams them over SSE to the PWA. The deck is
a landscape desk clock: time of day while idle, an incrementing session timer
from the moment a prompt is submitted, frozen on Stop — labeled with the
session's directory name, with a badge counting concurrently running sessions.
Events are server-timestamped and replayed from the ring buffer on reconnect
(`Last-Event-ID`), so a network blip never leaves the deck stale; while the
stream is down the deck shows an unmistakable gray scanline OFFLINE state.
Idle/running render dim for the always-on OLED, the layout pixel-shifts every
minute against burn-in, and Wake Lock keeps the docked screen alive.

**Activity ticker.** `PostToolUse` hooks (registered only for
`Write|Edit|MultiEdit|NotebookEdit|Bash`, so reads never pay a hook round
trip) feed a bounded audit strip. A table-driven classifier highlights
high-impact Bash commands (installs, migrations, docker, pushes, deploys);
everything else renders as a dim one-liner.

**Completion alerts that stay meaningful.** A `Stop` alerts only when the turn
ran at least the threshold (45s default, `SLOPDECK_ALERT_THRESHOLD_MS`) —
short chat turns stay silent. Channel follows visibility: a visible deck gets
a green boundary flash and a vibration tap; a backgrounded or locked phone
gets a Web Push notification carrying the session title (enable by setting
the VAPID variables from `deploy/.env.example` — without them, only in-page
alerts fire).

**Approve or deny from the deck.** A `PermissionRequest` http hook — it fires
only when a permission dialog would genuinely appear, so allowlisted commands
never reach the deck — is held open by the gateway while the deck takes over
the screen: tool name plus the exact command/path payload in real monospace,
with **Allow** (hold-to-fill, scaled to risk), **Deny**, and
**Ask-in-terminal** taps. Allow/Deny answer the hook with the documented
decision JSON; Ask-in-terminal — and every fallback — returns *no decision*,
letting the terminal dialog proceed normally. Fallbacks never auto-deny:
immediately when no deck is connected, at 540s (under the 600s hook timeout)
when a connected deck stays silent. Prompts queue FIFO, oldest first, with a
queue-depth badge.

**Pause** is one tap, no arming ritual: it flips the gateway to passthrough,
and while paused every `PermissionRequest` falls back to the terminal
instantly. The deck tints purple while paused; tapping again resumes
interception. The same switch is reachable from the workstation as
`slopdeck on` / `slopdeck off`.

**Answer Claude's questions remotely** (opt-in): with question interception
enabled, a `PreToolUse` http hook matched to `AskUserQuestion` alone lets the
deck render the question with one tap-target per choice (plus an
Ask-in-terminal escape); the tapped choice returns as
`permissionDecision: "deny"` with reason `User selected: <choice>` — which
Claude reads as the answer. Multi-question calls step through the card one
question at a time, and `multiSelect` questions render toggleable choices
with a CONFIRM tap. Every fallback (no deck, pause, timeout, unrecognized
payload shape) returns `permissionDecision: "ask"` so the question renders in
the terminal normally. An unanswered card falls back after 60s total for the
whole call (`SLOPDECK_QUESTION_TIMEOUT_MS`) — a stale answer to a question
mid-plan is worse than a terminal re-ask; permission prompts keep their 540s
window. This rides on **undocumented behavior**, so it ships behind its own
opt-in and hook matcher, and occasional terminal re-asks are expected, not
bugs. A canary test drives a real Claude Code session end-to-end to revalidate
the hack — run `npm run canary` after upgrading Claude Code (needs working
credentials, consumes tokens); if it reports the session ignored the deny
reason, disable question interception until revalidated.

## Quick start (use the hosted deck)

Don't want to run a server? Use the always-on hosted gateway. One command on
your workstation — no clone, no tokens, no `.env`:

```bash
npx github:Mawsis/ClaudeDeck slopdeck install
```

Pick **hosted** when asked, and scan the QR with your phone. That's it — the
deck pairs over HTTPS and works from anywhere. Requires **Node ≥ 22.6** and
[Claude Code](https://claude.com/claude-code) already set up on the machine.

To self-host the gateway instead (your own VPS, full privacy), follow the
walkable path below.

## The walkable path (self-hosted)

Four steps: deploy the gateway → wire the workstation → scan the QR → dock
the phone.

### 1. Deploy the gateway (VPS)

First time, on the VPS:

```bash
git clone <this repo> slopdeck && cd slopdeck
cp deploy/.env.example deploy/.env   # fill in tokens + DECK_DOMAIN
cd deploy && docker compose up -d --build
```

Caddy provisions HTTPS for `DECK_DOMAIN` automatically. Every update after
that is one local command:

```bash
SLOPDECK_DEPLOY_HOST=deploy@your-vps ./deploy.sh
# or: ./deploy.sh deploy@your-vps
# SLOPDECK_DEPLOY_PATH overrides the remote checkout dir (default: slopdeck)
```

`deploy.sh` SSHes in, fast-forwards `main`, and rebuilds the compose stack.
**Deploys are deliberately manual** — no CI trigger. All gateway state is
in-memory, so a restart drops event history and any permission prompt
currently held open (the hook falls back to the terminal; nothing is
auto-denied). Deploy when you know the deck is quiet, not whenever a branch
merges.

### 2. Wire the workstation

In a clone of this repo on the workstation:

```bash
npm install
npx slopdeck install
```

The installer asks for the gateway URL, verifies the gateway is reachable,
prompts for the hook token (hidden — it never lands on screen or in shell
history), and verifies it against the gateway before touching anything. Then
it merges the hook config into `~/.claude/settings.json` (surgically — a
malformed settings file aborts with the disk untouched), writes a marked
export block to `~/.zshrc`, and asks whether to enable question interception.
Open a new shell afterwards so the hook token is exported.

### 3. Pair the phone

Install ends with the pairing finale: it prompts for the deck token and prints
a QR encoding `https://your-deck-domain/#deck-token=…` — the token rides the
URL fragment, so it never reaches HTTP requests or server logs. Scan it with
the phone camera and the deck is paired; the installer then sends a handshake
through the real hook path, and the mascot waves on the phone when the whole
chain (DNS, TLS, hook token, gateway, SSE, deck token) works end to end.

Re-pair any time — new phone, new domain — with `slopdeck qr`.

### 4. Dock it

Tap the idle clock: the deck goes fullscreen and locks landscape. Add to Home
Screen on Android for the installed-PWA experience (required for Web Push).
Wake Lock keeps the screen alive in the dock.

## Day-to-day controls

```
slopdeck on|off     flip interception (the deck's Pause switch, remotely)
slopdeck status     diagnose the whole chain on one screen
slopdeck qr         re-print the phone-pairing QR
slopdeck uninstall  remove the hooks and the .zshrc block
```

## Develop

```bash
npm install
npm test                 # vitest suite (unit + e2e tracer + deploy.sh)
npm run typecheck
SLOPDECK_HOOK_TOKEN=$(openssl rand -hex 32) \
SLOPDECK_DECK_TOKEN=$(openssl rand -hex 32) \
npm run dev              # gateway + PWA on :8484
```
