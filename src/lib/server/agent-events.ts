// Lightweight pub/sub for agent check-in events.
import { createEmitter } from './emitter.js';

const emitter = createEmitter();
export const onAgentEvent = emitter.subscribe;
export const emitAgentEvent = emitter.emit;
