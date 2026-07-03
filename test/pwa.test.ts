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
