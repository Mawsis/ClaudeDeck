# ClaudeDeck

Ambient phone-as-deck companion + remote permission control for Claude Code.
Design record: [DECISIONS.md](DECISIONS.md).

Current state: **ambient session clock** — Claude Code `UserPromptSubmit` and
`Stop` hooks POST to the gateway, which streams them over SSE to the PWA. The
deck is a landscape desk clock: time of day while idle, an incrementing session
timer from the moment a prompt is submitted, frozen on Stop — labeled with the
session's directory name. Wake Lock keeps the docked screen alive.

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
```

Merge the printed JSON into `~/.claude/settings.json`, export
`CLAUDEDECK_HOOK_TOKEN` in your shell, and open the gateway URL on the phone —
paste the deck token once when prompted.
