# Hosted gateway deploy + verification (issue #34)

The always-on workspace gateway at **slopdeck.mawsis.dev**, running Caddy-free
behind the shared Dokploy Traefik, with a persistent SQLite volume. This is a
**HITL** procedure — it needs your VPS and your eyes.

The launch-critical property: gateway state now includes the SQLite workspace
table. A redeploy must **not** wipe it. Verify the volume mount before the first
real user.

---

## 0. Prerequisites (on the VPS)

- Dokploy running with its shared `dokploy-network` and Traefik reachable on
  ports 80/443.
- A DNS `A` record for `slopdeck.mawsis.dev` → the VPS.
- The repo checked out at `$SLOPDECK_DEPLOY_PATH` (default `slopdeck`), on `main`.
- `deploy/.env` present (can be minimal — the mps override runs token-free).

The mps override routes with these Traefik labels (override in `deploy/.env` if
your shared Traefik differs):

| var | default |
|---|---|
| `SLOPDECK_DOMAIN` | `slopdeck.mawsis.dev` |
| `SLOPDECK_TRAEFIK_ENTRYPOINT` | `websecure` |
| `SLOPDECK_TRAEFIK_CERTRESOLVER` | `letsencrypt` |
| `SLOPDECK_MINT_RATE_MAX` | `10` |
| `SLOPDECK_MINT_RATE_WINDOW_MS` | `60000` |

---

## 1. Deploy

From your workstation:

```bash
SLOPDECK_DEPLOY_MODE=hosted SLOPDECK_DEPLOY_HOST=deploy@your-vps ./deploy.sh
```

This SSHes in, fast-forwards `main`, and runs:

```bash
docker compose -f docker-compose.yml -f docker-compose.mps.yml up -d --build gateway
```

Only the `gateway` service starts — the base Caddy never comes up (Traefik owns
TLS). The `slopdeck_data` volume is mounted at `/data`; `SLOPDECK_DB_PATH`
points the store at `/data/slopdeck.sqlite`.

> **Note (mps):** `/root/slopdeck` on the mps box is a plain source directory,
> not a git checkout, so `deploy.sh`'s `git pull` path does **not** apply there —
> the box is updated by syncing source (rsync) and `docker compose ... build`.

> **Fresh volume (was issue #38, now fixed):** a brand-new named volume mounts
> `/data` as root, but the app runs as `node` (uid 1000). The image entrypoint
> (`deploy/docker-entrypoint.sh`) starts as root, chowns `/data` to node, then
> drops privileges via `su-exec` — so a fresh volume boots clean with no manual
> chown. If you ever see `ERR_SQLITE_ERROR`, confirm the entrypoint is in the
> image (`ENTRYPOINT ["docker-entrypoint.sh"]`).

### Verify the volume BEFORE the first user (the #34 gate)

```bash
# On the VPS:
docker volume ls | grep slopdeck_data          # the volume exists
docker compose -f docker-compose.yml -f docker-compose.mps.yml exec gateway \
  ls -la /data                                  # slopdeck.sqlite is here
```

If `/data/slopdeck.sqlite` is missing after a mint (step 2), the volume is not
wired — STOP and fix before onboarding anyone. (Root cause this closes: the
gateway used to open an in-memory DB regardless of any mount; it now honors
`SLOPDECK_DB_PATH`.)

---

## 2. AC: off-LAN mint + pair over HTTPS

From a workstation **not on the VPS LAN**:

```bash
slopdeck install        # choose "hosted"; it mints against slopdeck.mawsis.dev
```

Expected: a workspace is minted (no token typed), a QR prints. Scan it with a
phone on cellular (not the VPS Wi-Fi). The deck loads over HTTPS and pairs.

Raw endpoint check (what `install` calls under the hood):

```bash
curl -sS -X POST https://slopdeck.mawsis.dev/api/mint/hosted
# → 201 {"workspaceId":"…","hookKey":"…","deckKey":"…"}
```

- [ ] Hosted install mints + phone pairs from off-LAN over HTTPS

---

## 3. AC: two workspaces are isolated in production

1. Mint **workspace A** (`slopdeck install` on machine 1, pair phone A).
2. Mint **workspace B** (machine 2, pair phone B) — a second, independent mint.
3. Run a Claude session on machine A. Confirm **phone A shows the events and
   phone B shows nothing**.
4. Run a session on machine B; confirm the reverse.

- [ ] Deck A never shows deck B's events (and vice versa)

This is the non-retrofittable guarantee; the automated `test/isolation.test.ts`
proves the code path, this step proves it end-to-end in prod.

---

## 4. AC: a restart/redeploy preserves an existing workspace

With workspace A still paired:

```bash
# On the VPS — the redeploy path:
docker compose -f docker-compose.yml -f docker-compose.mps.yml up -d --build gateway
```

Then, from machine A **without re-installing**:

```bash
slopdeck status         # workspace A's key still authenticates; deck reconnects
```

Or hit the stream directly with A's deck key — it must still resolve. If the
key now 401s, persistence failed (volume not mounted / wrong `SLOPDECK_DB_PATH`).

- [ ] A rebuild preserves an existing workspace (no data loss)

---

## 5. AC: rapid repeated mints are rate-limited

Default limit is 10 mints / 60s per client IP. Fire more than the limit fast:

```bash
for i in $(seq 1 15); do
  curl -s -o /dev/null -w "%{http_code}\n" -X POST https://slopdeck.mawsis.dev/api/mint/hosted
done
# Expect: 201 up to the limit, then 429 for the rest.
```

**Proxy note (was issue #37, now fixed):** slopdeck.mawsis.dev is behind
**Cloudflare → Traefik**, and each request egresses from a different Cloudflare
edge IP — so keying on the `x-forwarded-for` right-most hop never accumulated a
bucket (all mints returned 201). The limiter now keys on `cf-connecting-ip`
first (stable per client behind Cloudflare), then `x-real-ip`, then the XFF
right-most hop for single-proxy deploys. Verified: exactly `MAX` mints, then 429.

- [ ] Rapid repeated mints get 429

---

## 6. Record findings — do not fix ad hoc

Per #34's acceptance criteria: **any finding becomes a follow-up issue.** Note
the symptom, which step surfaced it, and the observed vs. expected behavior.
Nothing gets patched inside this deploy pass.
