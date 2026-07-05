import { randomUUID } from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'
import { equals, generate, hash } from './workspace-key.ts'

/** `scope` distinguishes hook vs deck key material within a workspace. */
export type WorkspaceScope = 'hook' | 'deck'

/** Which key material a presented key matched — the ingest door vs the stream door. */
export type ScopedIdentity = { readonly workspaceId: string; readonly scope: WorkspaceScope }

export type WorkspaceStore = {
  create(): { workspaceId: string; key: string }
  /**
   * Mints a workspace carrying both keys: a hook key for ingest and a deck key
   * for the stream, two rows sharing one `workspace_id`. This is the isolation
   * unit the live gateway keys everything on.
   */
  createWorkspace(): { workspaceId: string; hookKey: string; deckKey: string }
  authenticate(key: string): string | null
  /** Like `authenticate`, but also reports which scope the key belongs to. */
  authenticateScoped(key: string): ScopedIdentity | null
  /**
   * Pre-seeds one workspace from caller-supplied hook/deck keys (env-token
   * backward compat). The keys are the exact static tokens already deployed —
   * not freshly generated — so an existing install keeps authenticating.
   * Returns the new workspace id.
   */
  seedWorkspace(hookKey: string, deckKey: string): string
  rotate(key: string): { key: string } | null
  touch(workspaceId: string): void
  /** The distinct workspace ids last seen strictly before `before` (would be swept). */
  expiredIds(before: number): string[]
  /** Removes workspaces last seen strictly before `before`; returns the count. */
  deleteExpired(before: number): number
}

export type WorkspaceStoreOptions = {
  /** Injectable for hermetic tests; defaults to a fresh in-memory database. */
  db?: DatabaseSync
  /** Injectable clock for deterministic `created_at`/`last_seen`. */
  now?: () => number
  scope?: WorkspaceScope
}

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS workspaces (
    workspace_id TEXT NOT NULL,
    key_hash     TEXT NOT NULL,
    scope        TEXT NOT NULL,
    created_at   INTEGER NOT NULL,
    last_seen    INTEGER NOT NULL,
    account_id   TEXT,
    -- A workspace holds one key row per scope (hook + deck), so identity is
    -- the (id, scope) pair, not the id alone. key_hash stays unique so no two
    -- rows can ever share a credential.
    PRIMARY KEY (workspace_id, scope)
  )
`

type WorkspaceRow = {
  readonly workspace_id: string
  readonly key_hash: string
  readonly scope: WorkspaceScope
}

export function createWorkspaceStore(options: WorkspaceStoreOptions = {}): WorkspaceStore {
  const db = options.db ?? new DatabaseSync(':memory:')
  const now = options.now ?? Date.now
  const scope = options.scope ?? 'deck'
  db.exec(SCHEMA)

  const insert = db.prepare(
    `INSERT INTO workspaces (workspace_id, key_hash, scope, created_at, last_seen)
     VALUES (?, ?, ?, ?, ?)`,
  )
  const all = db.prepare('SELECT workspace_id, key_hash, scope FROM workspaces')
  const updateHash = db.prepare(
    'UPDATE workspaces SET key_hash = ? WHERE workspace_id = ?',
  )
  const updateSeen = db.prepare(
    'UPDATE workspaces SET last_seen = ? WHERE workspace_id = ?',
  )
  const countStaleWorkspaces = db.prepare(
    'SELECT COUNT(DISTINCT workspace_id) AS n FROM workspaces WHERE last_seen < ?',
  )
  const staleWorkspaceIds = db.prepare(
    'SELECT DISTINCT workspace_id FROM workspaces WHERE last_seen < ?',
  )
  const deleteStale = db.prepare('DELETE FROM workspaces WHERE last_seen < ?')

  // Only SHA-256(key) is on disk, so no key can be looked up directly — every
  // key check scans *all* rows and timing-safe compares each stored hash. The
  // scan does not early-return on a hit, so lookup time is independent of which
  // row matches (or whether any does) — no match-position or count timing leak.
  const findByKey = (key: string): ScopedIdentity | null => {
    let found: ScopedIdentity | null = null
    for (const row of all.all() as WorkspaceRow[]) {
      if (equals(row.key_hash, key)) found = { workspaceId: row.workspace_id, scope: row.scope }
    }
    return found
  }

  return {
    create() {
      const workspaceId = randomUUID()
      const key = generate()
      const at = now()
      insert.run(workspaceId, hash(key), scope, at, at)
      return { workspaceId, key }
    },

    createWorkspace() {
      const workspaceId = randomUUID()
      const hookKey = generate()
      const deckKey = generate()
      const at = now()
      // Two rows, one workspace_id: the hook door and the deck door share an
      // isolation boundary but never each other's key material.
      insert.run(workspaceId, hash(hookKey), 'hook', at, at)
      insert.run(workspaceId, hash(deckKey), 'deck', at, at)
      return { workspaceId, hookKey, deckKey }
    },

    seedWorkspace(hookKey, deckKey) {
      const workspaceId = randomUUID()
      const at = now()
      // The keys are the caller's existing static tokens — hashed like any
      // other so plaintext still never touches disk, but not regenerated.
      insert.run(workspaceId, hash(hookKey), 'hook', at, at)
      insert.run(workspaceId, hash(deckKey), 'deck', at, at)
      return workspaceId
    },

    authenticate(key) {
      return findByKey(key)?.workspaceId ?? null
    },

    authenticateScoped(key) {
      return findByKey(key)
    },

    rotate(key) {
      // Holding the current key *is* the auth — no account needed. We mint a
      // fresh key and overwrite the stored hash; the old key is dead the moment
      // its hash is gone from the row.
      const identity = findByKey(key)
      if (identity === null) return null
      const next = generate()
      updateHash.run(hash(next), identity.workspaceId)
      return { key: next }
    },

    touch(workspaceId) {
      // Feeds the ephemeral-expiry decision with real activity data. A miss on
      // an unknown id updates zero rows — a harmless no-op, not an error.
      updateSeen.run(now(), workspaceId)
    },

    expiredIds(before) {
      // The distinct workspaces a `deleteExpired(before)` would remove — so the
      // caller can evict their in-memory runtimes in lockstep with the sweep.
      return (staleWorkspaceIds.all(before) as { workspace_id: string }[]).map(
        (row) => row.workspace_id,
      )
    },

    deleteExpired(before) {
      // Strictly-before: a workspace seen exactly at the cutoff is not yet
      // expired. Sweeps abandoned/abusive anonymous workspaces; `touch` keeps
      // active ones alive by pushing last_seen forward. Counts distinct
      // *workspaces*, not rows — a workspace has a hook row and a deck row, and
      // the caller expects "one workspace swept" to read as 1, not 2.
      const { n } = countStaleWorkspaces.get(before) as { n: number }
      deleteStale.run(before)
      return Number(n)
    },
  }
}
