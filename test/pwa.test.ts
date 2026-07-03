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
})
