import { describe, expect, it } from 'vitest'
import { buildApp } from './helpers.ts'

describe('PWA shell', () => {
  it('serves the deck page at the root without auth', async () => {
    const { app } = buildApp()

    const response = await app.request('/')

    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toContain('text/html')
    expect(await response.text()).toContain('ClaudeDeck')
  })

  it('renders the deck as a dumb projection: imports the reducer, listens to prompt and stop, holds a wake lock', async () => {
    const { app } = buildApp()

    const html = await (await app.request('/')).text()

    expect(html).toContain("from '/deck-reducer.js'")
    expect(html).toContain("addEventListener('prompt'")
    expect(html).toContain("addEventListener('stop'")
    expect(html).toContain('navigator.wakeLock')
    expect(html).toContain('Press Start 2P')
  })

  it('never lies: renders from connection state, server event times, and a shifting layout', async () => {
    const { app } = buildApp()

    const html = await (await app.request('/')).text()

    // Connection state flows into the projection — offline replaces the clock.
    expect(html).toContain('connected')
    expect(html).toMatch(/source\.onopen/)
    expect(html).toMatch(/source\.onerror/)
    // Reducer consumes event times rebased onto the deck's own clock —
    // replay-truthful without importing server clock skew into the live tick.
    expect(html).toContain('localEventTime(event')
    // OLED burn-in protection: the layout drifts on a minute index.
    expect(html).toContain('ambientShift')
  })

  it('renders the activity ticker: tool events reduce into a risk-differentiated VT323 strip', async () => {
    const { app } = buildApp()

    const html = await (await app.request('/')).text()

    // Tool events flow through the same pure-reducer path as the clock.
    expect(html).toContain("addEventListener('tool'")
    expect(html).toContain('reduceTicker')
    // D13: ticker lines are VT323, not the display font.
    expect(html).toContain('VT323')
    expect(html).toContain('id="ticker"')
    // Highlighted vs routine rows differ by a data attribute the CSS keys on.
    expect(html).toContain("data-risk='highlighted'")
    // Commands are untrusted input — rows must be built with textContent,
    // never markup interpolation.
    expect(html).toContain('textContent')
    expect(html).not.toContain('innerHTML')
  })

  it('serves the deck reducer as a JS module the page can import', async () => {
    const { app } = buildApp()

    const response = await app.request('/deck-reducer.js')

    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toContain('javascript')
    expect(await response.text()).toContain('export function reduceDeck')
  })

  it('serves a service worker that shows pushes only when no deck window is visible', async () => {
    const { app } = buildApp()

    const response = await app.request('/sw.js')

    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toContain('javascript')
    const sw = await response.text()
    expect(sw).toContain("addEventListener('push'")
    // Delivery-time visibility check: a visible deck flashes in-page instead.
    expect(sw).toContain('visibilityState')
    expect(sw).toContain('showNotification')
    expect(sw).toContain("addEventListener('notificationclick'")
  })

  it('renders the approval card as a takeover: prompt events reduce, payload in a real monospace, three actions', async () => {
    const { app } = buildApp()

    const html = await (await app.request('/')).text()

    // Prompts flow through the same pure-reducer path as everything else.
    expect(html).toContain("addEventListener('permission'")
    expect(html).toContain("addEventListener('permission-resolved'")
    expect(html).toContain('reducePrompts')
    // D13: the payload — where misreading has consequences — is a crisp real
    // monospace, never the Press Start 2P / VT323 display fonts.
    expect(html).toContain('JetBrains Mono')
    expect(html).toMatch(/#approval-payload\s*{[^}]*JetBrains Mono/)
    // Three actions resolving over plain HTTP (D8).
    expect(html).toContain('id="approve-allow"')
    expect(html).toContain('id="approve-deny"')
    expect(html).toContain('id="approve-ask"')
    expect(html).toContain('/resolution')
    // Payload text is untrusted input — textContent only.
    expect(html).not.toContain('innerHTML')
    // D11: prompt arrival always alerts — the takeover comes with a buzz.
    expect(html).toContain('id="approval"')
  })

  it('recovers from a rejected token: a definitive 401/403 clears the saved token and re-shows the form', async () => {
    const { app } = buildApp()

    const html = await (await app.request('/')).text()

    // EventSource hides HTTP status — a dead gateway and a rejected token
    // look identical from onerror. The page must probe an authenticated
    // endpoint to tell them apart…
    expect(html).toContain('401')
    expect(html).toContain('403')
    // …and a rejected token is cleared, never silently retried forever:
    // the paste form comes back instead of a stuck OFFLINE clock.
    expect(html).toContain('removeItem')
    expect(html).toContain('rejected')
  })

  it('accident-proofs Allow (D15): risk-scaled hold-to-fill, cancel on release, Deny and Ask stay single taps', async () => {
    const { app } = buildApp()

    const html = await (await app.request('/')).text()

    // The hold begins on pointerdown, scaled by the card's risk through the
    // shared reducer's duration table.
    expect(html).toContain('allowHoldMs')
    expect(html).toContain('pointerdown')
    // Releasing early, sliding off, or losing the pointer resets the bar.
    expect(html).toContain('pointerup')
    expect(html).toContain('pointercancel')
    expect(html).toContain('pointerleave')
    // The pixel-art charge bar is its own element the CSS fills.
    expect(html).toContain('id="allow-fill"')
    // A tap or brush must do nothing: Allow has no click path to a decision…
    expect(html).not.toMatch(/approve-allow'\)\s*\.addEventListener\('click'/)
    // …while Deny and Ask-in-terminal remain single taps.
    expect(html).toMatch(/approve-deny'\)\s*\.addEventListener\('click'/)
    expect(html).toMatch(/approve-ask'\)\s*\.addEventListener\('click'/)
  })

  it('service worker renders a permission push distinctly — its own tag, never collapsed into a done alert', async () => {
    const { app } = buildApp()

    const sw = await (await app.request('/sw.js')).text()

    // A permission prompt blocks a session — it must not overwrite, nor be
    // overwritten by, a routine done notification.
    expect(sw).toContain("kind === 'permission'")
    expect(sw).toContain('claudedeck-permission')
    expect(sw).toContain('claudedeck-done')
    expect(sw).toContain('PERMISSION')
  })

  it('exposes a one-tap Pause (D5): posts to /api/pause, listens for mode events, paints the paused accent from the reducer view', async () => {
    const { app } = buildApp()

    const html = await (await app.request('/')).text()

    // A single control, deck-scoped POST — no arming ritual.
    expect(html).toContain('id="pause-toggle"')
    expect(html).toContain('/api/pause')
    // The mode change streams back as its own event and flows through the same
    // pure-reducer path as everything else.
    expect(html).toContain("addEventListener('mode'")
    expect(html).toContain('reduceDeck')
    // D14: the purple paused accent is a data attribute the CSS keys on, driven
    // by the reducer view's paused flag — not toggled imperatively.
    expect(html).toContain('view.paused')
    expect(html).toContain('data-paused')
    expect(html).toMatch(/--paused:\s*#a855f7/)
    // A hard reload learns the current mode from deck-config, not just live SSE.
    expect(html).toContain('deckConfig.paused')
  })

  it('alerts through the shared reducer: in-page flash + vibration, push subscription re-registered on connect', async () => {
    const { app } = buildApp()

    const html = await (await app.request('/')).text()

    // The channel decision is the reducer's, fed the page's real visibility
    // and receipt time (so ring-buffer replay on reload never re-alerts).
    expect(html).toContain('completionAlert')
    expect(html).toContain('document.visibilityState')
    expect(html).toContain('now: receiptNow')
    expect(html).toContain('navigator.vibrate')
    expect(html).toContain('alert-flash')
    // Threshold and VAPID key come from the gateway, not page constants.
    expect(html).toContain('/api/deck-config')
    // Subscriptions are held in gateway memory — every connect re-registers.
    expect(html).toContain('/api/push/subscriptions')
    expect(html).toContain('serviceWorker')
  })
})
