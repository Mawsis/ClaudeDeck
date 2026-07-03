import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  createPendingPromptStore,
  DEFAULT_PERMISSION_TIMEOUT_MS,
  type PermissionDecision,
} from '../src/gateway/pending-prompts.ts'

afterEach(() => {
  vi.useRealTimers()
})

describe('pending-prompt store', () => {
  it('resolves a held prompt with the decision tapped on the deck', async () => {
    const store = createPendingPromptStore({ hasDeck: () => true })

    const held = store.hold()
    const resolved = store.resolve(held.id, { behavior: 'allow' })

    expect(resolved).toBe(true)
    await expect(held.decision).resolves.toEqual({ behavior: 'allow' })
  })

  it('falls back immediately with no decision when no deck is connected — zero added latency', async () => {
    const store = createPendingPromptStore({ hasDeck: () => false })

    const held = store.hold()

    await expect(held.decision).resolves.toBeNull()
    // Never became pending — nothing should alert for it.
    expect(held.pending).toBe(false)
  })

  it('reports a deck-held prompt as pending — the signal that arrival alerts key on', () => {
    const store = createPendingPromptStore({ hasDeck: () => true })

    const held = store.hold()

    expect(held.pending).toBe(true)
    store.resolve(held.id, null)
  })

  it('falls back with no decision at 540s when a connected deck stays silent — never auto-deny', async () => {
    vi.useFakeTimers()
    const store = createPendingPromptStore({ hasDeck: () => true })
    const held = store.hold()

    let settled: PermissionDecision | null | 'pending' = 'pending'
    void held.decision.then((decision) => {
      settled = decision
    })

    // One tick under the deadline: still held, the deck can still answer.
    await vi.advanceTimersByTimeAsync(DEFAULT_PERMISSION_TIMEOUT_MS - 1)
    expect(settled).toBe('pending')

    await vi.advanceTimersByTimeAsync(1)
    expect(settled).toBeNull()
    // 540s stays under the 600s hook timeout so the fallback — not a hook
    // error — is what the terminal sees (D4).
    expect(DEFAULT_PERMISSION_TIMEOUT_MS).toBe(540_000)
  })

  it('keeps the first resolution on a double tap — the second is a rejected no-op', async () => {
    const store = createPendingPromptStore({ hasDeck: () => true })
    const held = store.hold()

    expect(store.resolve(held.id, { behavior: 'deny' })).toBe(true)
    expect(store.resolve(held.id, { behavior: 'allow' })).toBe(false)

    await expect(held.decision).resolves.toEqual({ behavior: 'deny' })
  })

  it('rejects a resolution that lands after the silence fallback already answered', async () => {
    vi.useFakeTimers()
    const store = createPendingPromptStore({ hasDeck: () => true, timeoutMs: 1_000 })
    const held = store.hold()

    await vi.advanceTimersByTimeAsync(1_000)

    expect(store.resolve(held.id, { behavior: 'allow' })).toBe(false)
    await expect(held.decision).resolves.toBeNull()
  })

  it('rejects a resolution for an id it never held', () => {
    const store = createPendingPromptStore({ hasDeck: () => true })

    expect(store.resolve('no-such-prompt', { behavior: 'allow' })).toBe(false)
  })
})
