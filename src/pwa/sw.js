// Service worker for completion alerts. Registered as a module so the
// notification body reuses the exact formatter the deck renders with.
// Excluded from tsc (ServiceWorkerGlobalScope vs node lib globals); verified
// by content tests and the reducer's own unit tests.
import { formatElapsed } from './deck-reducer.js'

self.addEventListener('push', (event) => {
  event.waitUntil(showCompletion(event.data))
})

async function showCompletion(data) {
  let payload = {}
  try {
    payload = data ? data.json() : {}
  } catch {
    // A malformed payload still deserves a ping — it only loses its title.
  }

  const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true })
  // D11 channel choice, enforced at delivery time: a visible deck flashes and
  // vibrates in-page — a notification on top of it would be noise.
  if (windows.some((client) => client.visibilityState === 'visible')) return

  const title = typeof payload.title === 'string' && payload.title !== '' ? payload.title : 'session'
  const elapsed = typeof payload.elapsedMs === 'number' ? ` in ${formatElapsed(payload.elapsedMs)}` : ''
  await self.registration.showNotification(`■ DONE — ${title}`, {
    body: `Claude finished${elapsed}`,
    // Repeats collapse into one notification; the newest wins.
    tag: 'claudedeck-done',
  })
}

self.addEventListener('notificationclick', (event) => {
  event.notification.close()
  event.waitUntil(focusDeck())
})

async function focusDeck() {
  const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true })
  if (windows.length > 0) {
    await windows[0].focus()
  } else {
    await self.clients.openWindow('/')
  }
}
