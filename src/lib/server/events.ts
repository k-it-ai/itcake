// Server-Sent Events (SSE) singleton for real-time updates

type EventListener = (event: string, data: unknown) => void;

const MAX_LISTENERS = 50;

class EventEmitter {
	private listeners = new Set<EventListener>();

	subscribe(listener: EventListener): () => void {
		// Evict oldest listener if at capacity (prevents unbounded memory growth).
		// Notify evicted listener so it can trigger reconnection instead of silently hanging.
		if (this.listeners.size >= MAX_LISTENERS) {
			const oldest = this.listeners.values().next().value;
			if (oldest) {
				this.listeners.delete(oldest);
				try { oldest('evicted', { reason: 'max_listeners' }); } catch { /* best effort */ }
			}
		}
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}

	emit(event: string, data: unknown): void {
		for (const listener of this.listeners) {
			try { listener(event, data); } catch { /* best effort — one failing listener must not block others */ }
		}
	}

	get size(): number {
		return this.listeners.size;
	}
}

export const events = new EventEmitter();
