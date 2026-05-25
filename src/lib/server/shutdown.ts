import { log } from './log.js';

export interface ShutdownTaskOptions {
	timeoutMs?: number;
}

interface RegisteredTask {
	name: string;
	fn: () => unknown | Promise<unknown>;
	timeoutMs: number;
}

const DEFAULT_TASK_TIMEOUT_MS = 10_000;
const tasks: RegisteredTask[] = [];
let shuttingDown = false;
let signalsInstalled = false;
let shutdownPromise: Promise<void> | null = null;

export function isShuttingDown(): boolean {
	return shuttingDown;
}

export function registerShutdownTask(
	name: string,
	fn: () => unknown | Promise<unknown>,
	opts: ShutdownTaskOptions = {}
): void {
	tasks.push({ name, fn, timeoutMs: Math.max(100, opts.timeoutMs ?? DEFAULT_TASK_TIMEOUT_MS) });
}

async function runOne(task: RegisteredTask): Promise<void> {
	try {
		const r = task.fn();
		if (r && typeof (r as Promise<unknown>).then === 'function') {
			await Promise.race([
				r as Promise<unknown>,
				new Promise<void>((_, rej) =>
					setTimeout(() => rej(new Error('timeout')), task.timeoutMs).unref()
				)
			]);
		}
		log.debug('[shutdown] task ok', { name: task.name });
	} catch (e) {
		log.warn('[shutdown] task failed', {
			name: task.name,
			err: e instanceof Error ? e.message : String(e)
		});
	}
}

async function runShutdown(signal: string): Promise<void> {
	if (shutdownPromise) return shutdownPromise;
	shuttingDown = true;
	log.info('[shutdown] starting', { signal, tasks: tasks.length });
	shutdownPromise = (async () => {
		for (let i = tasks.length - 1; i >= 0; i--) {
			await runOne(tasks[i]);
		}
		log.info('[shutdown] complete');
	})();
	return shutdownPromise;
}

export function installSignalHandlers(): void {
	if (signalsInstalled) return;
	signalsInstalled = true;
	const onSig = (sig: NodeJS.Signals) => {
		void runShutdown(sig);
	};
	process.on('SIGTERM', onSig);
	process.on('SIGINT', onSig);
}

export function _resetShutdownForTests(): void {
	shuttingDown = false;
	signalsInstalled = false;
	shutdownPromise = null;
	tasks.length = 0;
}

export function _runShutdownForTests(signal = 'TEST'): Promise<void> {
	return runShutdown(signal);
}
