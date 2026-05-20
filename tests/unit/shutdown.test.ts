import { describe, it, expect, beforeEach } from 'vitest';
import {
	registerShutdownTask,
	isShuttingDown,
	_resetShutdownForTests,
	_runShutdownForTests
} from '../../src/lib/server/shutdown.js';

describe('shutdown coordinator', () => {
	beforeEach(() => _resetShutdownForTests());

	it('runs tasks in reverse-registration order', async () => {
		const calls: string[] = [];
		registerShutdownTask('first', () => { calls.push('first'); });
		registerShutdownTask('second', () => { calls.push('second'); });
		registerShutdownTask('third', () => { calls.push('third'); });
		await _runShutdownForTests();
		expect(calls).toEqual(['third', 'second', 'first']);
	});

	it('awaits async tasks', async () => {
		const calls: string[] = [];
		registerShutdownTask('async', async () => {
			await new Promise(r => setTimeout(r, 20));
			calls.push('async-done');
		});
		registerShutdownTask('sync', () => { calls.push('sync-done'); });
		await _runShutdownForTests();
		// sync registered last → runs first, but async ran AFTER (LIFO is 'sync' then 'async').
		expect(calls).toEqual(['sync-done', 'async-done']);
	});

	it('flips isShuttingDown() immediately when shutdown begins', async () => {
		expect(isShuttingDown()).toBe(false);
		let observedFlag = false;
		registerShutdownTask('observe', () => { observedFlag = isShuttingDown(); });
		await _runShutdownForTests();
		expect(observedFlag).toBe(true);
		expect(isShuttingDown()).toBe(true);
	});

	it('continues past a throwing task', async () => {
		const calls: string[] = [];
		registerShutdownTask('ok-1', () => { calls.push('ok-1'); });
		registerShutdownTask('throws', () => { throw new Error('boom'); });
		registerShutdownTask('ok-2', () => { calls.push('ok-2'); });
		await _runShutdownForTests();
		expect(calls).toEqual(['ok-2', 'ok-1']);
	});

	it('enforces per-task timeout (does not block others)', async () => {
		const calls: string[] = [];
		registerShutdownTask('quick', () => { calls.push('quick'); });
		registerShutdownTask('hung', () => new Promise(() => { /* never resolves */ }), { timeoutMs: 100 });
		const start = Date.now();
		await _runShutdownForTests();
		const elapsed = Date.now() - start;
		expect(elapsed).toBeLessThan(2000);
		// hung registered last → runs first, then quick still runs.
		expect(calls).toEqual(['quick']);
	});

	it('is idempotent (second call resolves the same promise)', async () => {
		let count = 0;
		registerShutdownTask('counter', () => { count++; });
		const p1 = _runShutdownForTests();
		const p2 = _runShutdownForTests();
		await Promise.all([p1, p2]);
		expect(count).toBe(1);
	});
});
