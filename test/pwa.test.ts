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
    // Reducer consumes the server publish time, not client receipt time.
    expect(html).toContain('at: event.at')
    // OLED burn-in protection: the layout drifts on a minute index.
    expect(html).toContain('ambientShift')
  })

  it('serves the deck reducer as a JS module the page can import', async () => {
    const { app } = buildApp()

    const response = await app.request('/deck-reducer.js')

    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toContain('javascript')
    expect(await response.text()).toContain('export function reduceDeck')
  })
})
