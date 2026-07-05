export function createPauseState() {
    let paused = false;
    return {
        isPaused: () => paused,
        toggle() {
            paused = !paused;
            return paused;
        },
        set(next) {
            paused = next;
            return paused;
        },
    };
}
