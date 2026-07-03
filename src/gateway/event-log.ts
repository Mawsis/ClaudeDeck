import type { DeckEvent, DeckEventInput } from './events.ts'

export type Subscriber = (event: DeckEvent) => void

export type EventLog = {
  publish(input: DeckEventInput): DeckEvent
  subscribe(subscriber: Subscriber): () => void
  history(): readonly DeckEvent[]
}

const DEFAULT_CAPACITY = 500

export function createEventLog(options: { capacity?: number } = {}): EventLog {
  const capacity = options.capacity ?? DEFAULT_CAPACITY
  let nextId = 1
  let buffer: readonly DeckEvent[] = []
  const subscribers = new Set<Subscriber>()

  return {
    publish(input) {
      const event: DeckEvent = Object.freeze({ ...input, id: nextId })
      nextId += 1
      buffer = [...buffer, event].slice(-capacity)
      for (const subscriber of subscribers) {
        subscriber(event)
      }
      return event
    },

    subscribe(subscriber) {
      subscribers.add(subscriber)
      return () => subscribers.delete(subscriber)
    },

    history() {
      return buffer
    },
  }
}
