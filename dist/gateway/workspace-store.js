import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { equals, generate, hash } from "./workspace-key.js";
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
`;
export function createWorkspaceStore(options = {}) {
    const db = options.db ?? new DatabaseSync(':memory:');
    const now = options.now ?? Date.now;
    const scope = options.scope ?? 'deck';
    db.exec(SCHEMA);
    const insert = db.prepare(`INSERT INTO workspaces (workspace_id, key_hash, scope, created_at, last_seen)
     VALUES (?, ?, ?, ?, ?)`);
    const all = db.prepare('SELECT workspace_id, key_hash, scope FROM workspaces');
    const updateHash = db.prepare('UPDATE workspaces SET key_hash = ? WHERE workspace_id = ?');
    const updateHashByScope = db.prepare('UPDATE workspaces SET key_hash = ? WHERE workspace_id = ? AND scope = ?');
    const updateSeen = db.prepare('UPDATE workspaces SET last_seen = ? WHERE workspace_id = ?');
    const countStaleWorkspaces = db.prepare('SELECT COUNT(DISTINCT workspace_id) AS n FROM workspaces WHERE last_seen < ?');
    const staleWorkspaceIds = db.prepare('SELECT DISTINCT workspace_id FROM workspaces WHERE last_seen < ?');
    const deleteStale = db.prepare('DELETE FROM workspaces WHERE last_seen < ?');
    // Only SHA-256(key) is on disk, so no key can be looked up directly — every
    // key check scans *all* rows and timing-safe compares each stored hash. The
    // scan does not early-return on a hit, so lookup time is independent of which
    // row matches (or whether any does) — no match-position or count timing leak.
    const findByKey = (key) => {
        let found = null;
        for (const row of all.all()) {
            if (equals(row.key_hash, key))
                found = { workspaceId: row.workspace_id, scope: row.scope };
        }
        return found;
    };
    // Re-mint BOTH scope rows independently (keyed by workspace_id + scope, so the
    // hook and deck rows get distinct fresh hashes), invalidating both old keys
    // and handing back a fresh usable pair.
    const reinscribe = (workspaceId) => {
        const hookKey = generate();
        const deckKey = generate();
        updateHashByScope.run(hash(hookKey), workspaceId, 'hook');
        updateHashByScope.run(hash(deckKey), workspaceId, 'deck');
        return { hookKey, deckKey };
    };
    return {
        create() {
            const workspaceId = randomUUID();
            const key = generate();
            const at = now();
            insert.run(workspaceId, hash(key), scope, at, at);
            return { workspaceId, key };
        },
        createWorkspace() {
            const workspaceId = randomUUID();
            const hookKey = generate();
            const deckKey = generate();
            const at = now();
            // Two rows, one workspace_id: the hook door and the deck door share an
            // isolation boundary but never each other's key material.
            insert.run(workspaceId, hash(hookKey), 'hook', at, at);
            insert.run(workspaceId, hash(deckKey), 'deck', at, at);
            return { workspaceId, hookKey, deckKey };
        },
        seedWorkspace(hookKey, deckKey) {
            const workspaceId = randomUUID();
            const at = now();
            // The keys are the caller's existing static tokens — hashed like any
            // other so plaintext still never touches disk, but not regenerated.
            insert.run(workspaceId, hash(hookKey), 'hook', at, at);
            insert.run(workspaceId, hash(deckKey), 'deck', at, at);
            return workspaceId;
        },
        authenticate(key) {
            return findByKey(key)?.workspaceId ?? null;
        },
        authenticateScoped(key) {
            return findByKey(key);
        },
        rotate(key) {
            // Holding the current key *is* the auth — no account needed. We mint a
            // fresh key and overwrite the stored hash; the old key is dead the moment
            // its hash is gone from the row.
            const identity = findByKey(key);
            if (identity === null)
                return null;
            const next = generate();
            updateHash.run(hash(next), identity.workspaceId);
            return { key: next };
        },
        rotateWorkspace(key) {
            // Either current key proves ownership of the whole workspace.
            const identity = findByKey(key);
            if (identity === null)
                return null;
            return reinscribe(identity.workspaceId);
        },
        rotateWorkspaceById(workspaceId) {
            return reinscribe(workspaceId);
        },
        touch(workspaceId) {
            // Feeds the ephemeral-expiry decision with real activity data. A miss on
            // an unknown id updates zero rows — a harmless no-op, not an error.
            updateSeen.run(now(), workspaceId);
        },
        expiredIds(before) {
            // The distinct workspaces a `deleteExpired(before)` would remove — so the
            // caller can evict their in-memory runtimes in lockstep with the sweep.
            return staleWorkspaceIds.all(before).map((row) => row.workspace_id);
        },
        deleteExpired(before) {
            // Strictly-before: a workspace seen exactly at the cutoff is not yet
            // expired. Sweeps abandoned/abusive anonymous workspaces; `touch` keeps
            // active ones alive by pushing last_seen forward. Counts distinct
            // *workspaces*, not rows — a workspace has a hook row and a deck row, and
            // the caller expects "one workspace swept" to read as 1, not 2.
            const { n } = countStaleWorkspaces.get(before);
            deleteStale.run(before);
            return Number(n);
        },
    };
}
