import { createEmitter } from './emitter.js';

interface EventPayload {
	event: string;
	data: unknown;
}

const emitter = createEmitter<EventPayload>({
	onEvict: (fn) => fn({ event: 'evicted', data: { reason: 'max_listeners' } })
});

export const events = {
	subscribe(listener: (event: string, data: unknown) => void): () => void {
		return emitter.subscribe(({ event, data }) => listener(event, data));
	},
	emit(event: string, data: unknown): void {
		emitter.emit({ event, data });
	},
	get size(): number {
		return emitter.size;
	}
};
