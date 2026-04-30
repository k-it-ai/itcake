// Lightweight pub/sub for monitor check completion events.
import { createEmitter } from './emitter.js';

const emitter = createEmitter();
export const onCheckComplete = emitter.subscribe;
export const emitCheckComplete = emitter.emit;
