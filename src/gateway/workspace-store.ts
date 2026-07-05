import { randomUUID } from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'
import { equals, generate, hash } from './workspace-key.ts'

/** `scope` distinguishes hook vs deck key material within a workspace. */
export type WorkspaceScope = 'hook' | 'deck'

export type WorkspaceStore = {
  create(): { workspaceId: string; key: string }
  authenticate(key: string): string | null
  rotate(key: string): { key: string } | null
  touch(workspaceId: string): void
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
    workspace_id TEXT PRIMARY KEY,
    key_hash     TEXT NOT NULL,
    scope        TEXT NOT NULL,
    created_at   INTEGER NOT NULL,
    last_seen    INTEGER NOT NULL,
    account_id   TEXT
  )
`

type WorkspaceRow = {
  readonly workspace_id: string
  readonly key_hash: string
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
  const all = db.prepare('SELECT workspace_id, key_hash FROM workspaces')
  const updateHash = db.prepare(
    'UPDATE workspaces SET key_hash = ? WHERE workspace_id = ?',
  )
  const updateSeen = db.prepare(
    'UPDATE workspaces SET last_seen = ? WHERE workspace_id = ?',
  )
  const deleteStale = db.prepare('DELETE FROM workspaces WHERE last_seen < ?')

  // Only SHA-256(key) is on disk, so no key can be looked up directly — every
  // key check scans *all* rows and timing-safe compares each stored hash. The
  // scan does not early-return on a hit, so lookup time is independent of which
  // row matches (or whether any does) — no match-position or count timing leak.
  const findByKey = (key: string): string | null => {
    let found: string | null = null
    for (const row of all.all() as WorkspaceRow[]) {
      if (equals(row.key_hash, key)) found = row.workspace_id
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

    authenticate(key) {
      return findByKey(key)
    },

    rotate(key) {
      // Holding the current key *is* the auth — no account needed. We mint a
      // fresh key and overwrite the stored hash; the old key is dead the moment
      // its hash is gone from the row.
      const workspaceId = findByKey(key)
      if (workspaceId === null) return null
      const next = generate()
      updateHash.run(hash(next), workspaceId)
      return { key: next }
    },

    touch(workspaceId) {
      // Feeds the ephemeral-expiry decision with real activity data. A miss on
      // an unknown id updates zero rows — a harmless no-op, not an error.
      updateSeen.run(now(), workspaceId)
    },

    deleteExpired(before) {
      // Strictly-before: a workspace seen exactly at the cutoff is not yet
      // expired. Sweeps abandoned/abusive anonymous workspaces; `touch` keeps
      // active ones alive by pushing last_seen forward.
      const { changes } = deleteStale.run(before)
      return Number(changes)
    },
  }
}
