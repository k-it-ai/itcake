import { createEmitter } from './emitter.js';

const emitter = createEmitter();
export const onCheckComplete = emitter.subscribe;
export const emitCheckComplete = emitter.emit;
