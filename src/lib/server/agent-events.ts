import { createEmitter } from './emitter.js';

const emitter = createEmitter();
export const onAgentEvent = emitter.subscribe;
export const emitAgentEvent = emitter.emit;
