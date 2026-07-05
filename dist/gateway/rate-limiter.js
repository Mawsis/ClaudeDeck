export function createRateLimiter(options) {
    const { max, windowMs } = options;
    const now = options.now ?? Date.now;
    // key → hit timestamps still inside the current window, oldest first.
    const hits = new Map();
    return {
        take(key) {
            const cutoff = now() - windowMs;
            // Drop timestamps that have aged out of the window before counting, so a
            // long-idle key never carries stale hits forward.
            const recent = (hits.get(key) ?? []).filter((at) => at > cutoff);
            if (recent.length >= max) {
                hits.set(key, recent);
                return false;
            }
            recent.push(now());
            hits.set(key, recent);
            return true;
        },
    };
}
