import { createApp, type AlertsConfig } from '../src/gateway/app.ts'
import { createWorkspaceStore, type WorkspaceStore } from '../src/gateway/workspace-store.ts'

export const HOOK_TOKEN = 'hook-token-for-tests-0123456789abcdef'
export const DECK_TOKEN = 'deck-token-for-tests-0123456789abcdef'

type BuildOptions = {
  now?: () => number
  alerts?: AlertsConfig
  permissionTimeoutMs?: number
  questionTimeoutMs?: number
  maxStreamClients?: number
}

function makeApp(store: WorkspaceStore, options: BuildOptions) {
  return createApp({
    workspaceStore: store,
    ...(options.now ? { now: options.now } : {}),
    ...(options.alerts ? { alerts: options.alerts } : {}),
    ...(options.permissionTimeoutMs !== undefined
      ? { permissionTimeoutMs: options.permissionTimeoutMs }
      : {}),
    ...(options.questionTimeoutMs !== undefined
      ? { questionTimeoutMs: options.questionTimeoutMs }
      : {}),
    ...(options.maxStreamClients !== undefined
      ? { maxStreamClients: options.maxStreamClients }
      : {}),
  })
}

/**
 * The single-workspace harness: one implicit workspace seeded from the fixed
 * test tokens, exactly as the env-token backward-compat path does in
 * production. Existing route tests keep driving HOOK_TOKEN/DECK_TOKEN
 * unchanged; under the hood those are now this one workspace's keys. `eventLog`
 * is that workspace's own log, so tests that publish directly keep working.
 */
export function buildApp(options: BuildOptions = {}) {
  const store = createWorkspaceStore(options.now ? { now: options.now } : {})
  const workspaceId = store.seedWorkspace(HOOK_TOKEN, DECK_TOKEN)
  const { app, runtimeFor } = makeApp(store, options)
  return { app, store, eventLog: runtimeFor(workspaceId).eventLog }
}

/**
 * The isolation harness: an empty store the test mints workspaces into with
 * `store.createWorkspace()`, so it can prove A never sees B across the real
 * HTTP surface.
 */
export function buildWorkspaceApp(options: BuildOptions = {}) {
  const store = createWorkspaceStore(options.now ? { now: options.now } : {})
  const { app, runtimeFor } = makeApp(store, options)
  return { app, store, runtimeFor }
}
