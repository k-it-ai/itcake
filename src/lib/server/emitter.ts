/**
 * Generic in-process emitter for SSE-style fanout. One canonical
 * implementation replaces three byte-equivalent copies that previously lived
 * in events.ts, agent-events.ts and monitor-events.ts.
 *
 * Bounded — when capacity is reached, the oldest listener is evicted so a
 * leaky SSE client can't keep an unbounded set alive. Callers that need a
 * "go reconnect" signal pass an `onEvict` to fire a final notification on
 * the evicted listener.
 */
const DEFAULT_MAX_LISTENERS = 50;

interface EmitterOptions<P> {
	maxListeners?: number;
	onEvict?: (listener: (payload: P) => void) => void;
}

interface Emitter<P> {
	subscribe(fn: (payload: P) => void): () => void;
	emit(payload: P): void;
	readonly size: number;
}

export function createEmitter<P = void>(opts: EmitterOptions<P> = {}): Emitter<P> {
	const listeners = new Set<(payload: P) => void>();
	const max = opts.maxListeners ?? DEFAULT_MAX_LISTENERS;
	return {
		subscribe(fn) {
			if (listeners.size >= max) {
				const oldest = listeners.values().next().value;
				if (oldest) {
					listeners.delete(oldest);
					if (opts.onEvict) {
						try { opts.onEvict(oldest); } catch { /* best effort */ }
					}
				}
			}
			listeners.add(fn);
			return () => listeners.delete(fn);
		},
		emit(payload) {
			for (const fn of listeners) {
				try { fn(payload); } catch { /* best effort — one failing listener must not block others */ }
			}
		},
		get size() {
			return listeners.size;
		}
	};
}
