import { DatabaseSync } from 'node:sqlite'
import { describe, expect, it } from 'vitest'
import { generate, hash } from '../src/gateway/workspace-key.ts'
import { createWorkspaceStore } from '../src/gateway/workspace-store.ts'

describe('workspace-store: scoped identity (hook + deck key per workspace)', () => {
  it('mints a hook key and a deck key that both resolve to the one workspace, each with its scope', () => {
    const store = createWorkspaceStore()

    const { workspaceId, hookKey, deckKey } = store.createWorkspace()

    // Two credentials, one workspace: the hook posts events and the deck reads
    // the stream, but they land on the same isolated deck. Scope is what the
    // auth layer uses to keep the ingest door and the stream door separate.
    expect(store.authenticateScoped(hookKey)).toEqual({ workspaceId, scope: 'hook' })
    expect(store.authenticateScoped(deckKey)).toEqual({ workspaceId, scope: 'deck' })
    expect(hookKey).not.toBe(deckKey)
  })

  it('returns null from authenticateScoped for a key that belongs to no workspace', () => {
    const store = createWorkspaceStore()
    store.createWorkspace()

    expect(store.authenticateScoped(generate())).toBeNull()
  })

  it("keeps scoped keys isolated — one workspace's deck key never resolves to another", () => {
    const store = createWorkspaceStore()

    const a = store.createWorkspace()
    const b = store.createWorkspace()

    expect(store.authenticateScoped(a.deckKey)).toEqual({ workspaceId: a.workspaceId, scope: 'deck' })
    expect(store.authenticateScoped(b.hookKey)).toEqual({ workspaceId: b.workspaceId, scope: 'hook' })
    expect(a.workspaceId).not.toBe(b.workspaceId)
  })

  it('seeds an implicit workspace from pre-existing hook/deck keys (env-token compat)', () => {
    const store = createWorkspaceStore()

    // The backward-compat path: two static env tokens become the hook key and
    // deck key of one pre-seeded workspace, so an existing deployment keeps
    // working with the exact tokens already in its .env.
    const workspaceId = store.seedWorkspace('env-hook-token-abc', 'env-deck-token-xyz')

    expect(store.authenticateScoped('env-hook-token-abc')).toEqual({ workspaceId, scope: 'hook' })
    expect(store.authenticateScoped('env-deck-token-xyz')).toEqual({ workspaceId, scope: 'deck' })
  })
})

describe('workspace-store: create + authenticate', () => {
  it('mints a workspace whose key authenticates back to that same workspace', () => {
    const store = createWorkspaceStore()

    const { workspaceId, key } = store.create()

    // The key handed out at create time is the credential that resolves the
    // workspace — this is the whole identity loop the isolation model rests on.
    expect(store.authenticate(key)).toBe(workspaceId)
  })

  it('returns null for a key that belongs to no workspace', () => {
    const store = createWorkspaceStore()
    store.create()

    expect(store.authenticate('not-a-real-key')).toBeNull()
  })

  it('returns null on an empty store — no key authenticates before any workspace exists', () => {
    const store = createWorkspaceStore()

    expect(store.authenticate('anything')).toBeNull()
  })

  it('returns null for a well-formed but unknown key scanned against a populated store', () => {
    const store = createWorkspaceStore()
    store.create()
    store.create()
    store.create()

    // A key of the exact minted shape that belongs to no row must miss cleanly —
    // the scan visits every row and still returns null.
    expect(store.authenticate(generate())).toBeNull()
  })

  it("keeps workspaces isolated — one workspace's key never resolves to another", () => {
    const store = createWorkspaceStore()

    const a = store.create()
    const b = store.create()

    // Each key resolves to exactly its own workspace and no other — the
    // isolation guarantee the whole product is built on.
    expect(store.authenticate(a.key)).toBe(a.workspaceId)
    expect(store.authenticate(b.key)).toBe(b.workspaceId)
    expect(a.workspaceId).not.toBe(b.workspaceId)
  })
})

describe('workspace-store: persistence stores only the hash', () => {
  it('writes SHA-256(key) to disk and never the plaintext key', () => {
    const db = new DatabaseSync(':memory:')
    const store = createWorkspaceStore({ db })

    const { key } = store.create()

    // Read the raw row the way a breach would — straight off the table.
    const rows = db.prepare('SELECT key_hash FROM workspaces').all() as { key_hash: string }[]
    expect(rows).toHaveLength(1)
    expect(rows[0]?.key_hash).toBe(hash(key))
    // The credential itself is nowhere on disk: a dump hands over only hashes.
    const dump = JSON.stringify(db.prepare('SELECT * FROM workspaces').all())
    expect(dump).not.toContain(key)
  })

  it('records scope so hook and deck key material are distinguishable in one workspace', () => {
    const db = new DatabaseSync(':memory:')
    const store = createWorkspaceStore({ db, scope: 'hook' })

    const { workspaceId } = store.create()

    const row = db
      .prepare('SELECT scope FROM workspaces WHERE workspace_id = ?')
      .get(workspaceId) as { scope: string }
    expect(row.scope).toBe('hook')
  })
})

describe('workspace-store: rotate', () => {
  it('mints a new working key for the same workspace', () => {
    const store = createWorkspaceStore()
    const { workspaceId, key } = store.create()

    const rotated = store.rotate(key)

    expect(rotated).not.toBeNull()
    expect(rotated?.key).not.toBe(key)
    // The new key resolves the same workspace — identity survives rotation.
    expect(store.authenticate(rotated!.key)).toBe(workspaceId)
  })

  it('invalidates the old key — the leaked credential stops authenticating', () => {
    const store = createWorkspaceStore()
    const { key } = store.create()

    store.rotate(key)

    // This is the point of rotate: the screenshotted/committed key is now dead.
    expect(store.authenticate(key)).toBeNull()
  })

  it('returns null and changes nothing when the presented key is not a workspace', () => {
    const store = createWorkspaceStore()
    const { key } = store.create()

    expect(store.rotate('not-a-key')).toBeNull()
    // The real key is untouched — a failed rotate is a no-op, not a lockout.
    expect(store.authenticate(key)).not.toBeNull()
  })
})

describe('workspace-store: touch', () => {
  it('advances last_seen to the current clock so expiry decisions have real data', () => {
    const db = new DatabaseSync(':memory:')
    let clock = 1_000
    const store = createWorkspaceStore({ db, now: () => clock })
    const { workspaceId } = store.create()

    clock = 5_000
    store.touch(workspaceId)

    const row = db
      .prepare('SELECT created_at, last_seen FROM workspaces WHERE workspace_id = ?')
      .get(workspaceId) as { created_at: number; last_seen: number }
    // created_at is frozen at mint; last_seen tracks the latest activity.
    expect(row.created_at).toBe(1_000)
    expect(row.last_seen).toBe(5_000)
  })

  it('is a harmless no-op for an unknown workspace id', () => {
    const store = createWorkspaceStore()

    expect(() => store.touch('no-such-workspace')).not.toThrow()
  })
})

describe('workspace-store: deleteExpired', () => {
  it('sweeps only workspaces last seen before the cutoff', () => {
    let clock = 1_000
    const store = createWorkspaceStore({ now: () => clock })

    const stale = store.create() // last_seen = 1_000
    clock = 9_000
    const active = store.create() // last_seen = 9_000

    // Cutoff sits between them: the stale one goes, the active one stays.
    const removed = store.deleteExpired(5_000)

    expect(removed).toBe(1)
    expect(store.authenticate(stale.key)).toBeNull()
    expect(store.authenticate(active.key)).toBe(active.workspaceId)
  })

  it('keeps a workspace whose last_seen was refreshed by touch past the cutoff', () => {
    let clock = 1_000
    const store = createWorkspaceStore({ now: () => clock })
    const ws = store.create() // last_seen = 1_000

    clock = 9_000
    store.touch(ws.workspaceId) // last_seen = 9_000, now beyond the cutoff

    // Activity rescues the workspace from the sweep — the whole point of touch.
    expect(store.deleteExpired(5_000)).toBe(0)
    expect(store.authenticate(ws.key)).toBe(ws.workspaceId)
  })

  it('removes nothing and returns zero when every workspace is active', () => {
    const store = createWorkspaceStore({ now: () => 10_000 })
    store.create()
    store.create()

    expect(store.deleteExpired(5_000)).toBe(0)
  })

  it('uses a strict cutoff — a workspace last seen exactly at the boundary survives', () => {
    const store = createWorkspaceStore({ now: () => 5_000 })
    const ws = store.create() // last_seen = 5_000

    // `before` means strictly-before; equal-to-cutoff is not yet expired.
    expect(store.deleteExpired(5_000)).toBe(0)
    expect(store.authenticate(ws.key)).toBe(ws.workspaceId)
  })
})
