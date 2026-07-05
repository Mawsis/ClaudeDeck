// One owner's devices, keyed by push endpoint — 8 is generous; beyond it the
// oldest registration is stale, not a ninth phone.
const DEFAULT_MAX_SUBSCRIPTIONS = 8;
/** 404/410 from a push service means the subscription is dead, not the network. */
function isSubscriptionGone(error) {
    const statusCode = typeof error === 'object' && error !== null
        ? error.statusCode
        : undefined;
    return statusCode === 404 || statusCode === 410;
}
export function createPushRegistry(send, options = {}) {
    const maxSubscriptions = options.maxSubscriptions ?? DEFAULT_MAX_SUBSCRIPTIONS;
    // Insertion-ordered: re-registration refreshes recency, so the cap always
    // evicts the longest-silent device, never the one that just reconnected.
    const subscriptions = new Map();
    return {
        register(subscription) {
            subscriptions.delete(subscription.endpoint);
            subscriptions.set(subscription.endpoint, subscription);
            while (subscriptions.size > maxSubscriptions) {
                const oldest = subscriptions.keys().next().value;
                if (oldest === undefined)
                    break;
                subscriptions.delete(oldest);
            }
        },
        broadcast(payload) {
            for (const [endpoint, subscription] of subscriptions) {
                // Fire-and-forget: a hook response must never wait on a push service.
                void send(subscription, payload).catch((error) => {
                    if (isSubscriptionGone(error)) {
                        subscriptions.delete(endpoint);
                    }
                    else {
                        console.error('push send failed:', error);
                    }
                });
            }
        },
    };
}
