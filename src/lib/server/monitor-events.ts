/** Lightweight pub/sub for monitor check completion events. */
type Listener = () => void;

const MAX_LISTENERS = 50;
const listeners = new Set<Listener>();

export function onCheckComplete(fn: Listener): () => void {
	if (listeners.size >= MAX_LISTENERS) {
		const oldest = listeners.values().next().value;
		if (oldest) listeners.delete(oldest);
	}
	listeners.add(fn);
	return () => listeners.delete(fn);
}

export function emitCheckComplete(): void {
	for (const fn of listeners) {
		try { fn(); } catch { /* best effort */ }
	}
}
