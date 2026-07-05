const DEFAULT_CAPACITY = 500;
export function createEventLog(options = {}) {
    const capacity = options.capacity ?? DEFAULT_CAPACITY;
    const now = options.now ?? Date.now;
    let nextId = 1;
    let buffer = [];
    const subscribers = new Set();
    return {
        publish(input) {
            const event = Object.freeze({ ...input, id: nextId, at: now() });
            nextId += 1;
            buffer = [...buffer, event].slice(-capacity);
            for (const subscriber of subscribers) {
                subscriber(event);
            }
            return event;
        },
        subscribe(subscriber) {
            subscribers.add(subscriber);
            return () => subscribers.delete(subscriber);
        },
        history() {
            return buffer;
        },
        since(afterId) {
            return buffer.filter((event) => event.id > afterId);
        },
    };
}
