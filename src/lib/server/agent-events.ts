/** Lightweight pub/sub for agent check-in events (same pattern as monitor-events.ts). */
type Listener = () => void;

const MAX_LISTENERS = 50;
const listeners = new Set<Listener>();

export function onAgentEvent(fn: Listener): () => void {
	if (listeners.size >= MAX_LISTENERS) {
		const oldest = listeners.values().next().value;
		if (oldest) listeners.delete(oldest);
	}
	listeners.add(fn);
	return () => listeners.delete(fn);
}

export function emitAgentEvent(): void {
	for (const fn of listeners) {
		try { fn(); } catch { /* best effort */ }
	}
}
