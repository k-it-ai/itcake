/** Lightweight pub/sub for monitor check completion events. */
type Listener = () => void;
const listeners = new Set<Listener>();

export function onCheckComplete(fn: Listener): () => void {
	listeners.add(fn);
	return () => listeners.delete(fn);
}

export function emitCheckComplete(): void {
	for (const fn of listeners) fn();
}
