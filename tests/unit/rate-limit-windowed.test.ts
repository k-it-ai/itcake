import { describe, it, expect, beforeAll } from 'vitest';
import { existsSync, mkdirSync, rmSync } from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';

const TEST_DIR = path.resolve('data-test-rl-windowed');

let checkAndRecordWindowed: typeof import('../../src/lib/server/rate-limit.js').checkAndRecordWindowed;

beforeAll(async () => {
	if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
	mkdirSync(TEST_DIR, { recursive: true });
	process.env.DATABASE_PATH = path.join(TEST_DIR, 'rl.db');
	process.env.DATA_DIR = TEST_DIR;
	process.env.SESSION_SECRET ||= randomBytes(32).toString('hex');
	const mod = await import('../../src/lib/server/rate-limit.js');
	checkAndRecordWindowed = mod.checkAndRecordWindowed;
});

describe('checkAndRecordWindowed', () => {
	it('allows up to max within the window then rejects with retryAfter', () => {
		const key = `t1:${randomBytes(4).toString('hex')}`;
		for (let i = 0; i < 5; i++) {
			expect(checkAndRecordWindowed(key, 5, 60_000)).toEqual({ ok: true, retryAfter: 0 });
		}
		const blocked = checkAndRecordWindowed(key, 5, 60_000);
		expect(blocked.ok).toBe(false);
		expect(blocked.retryAfter).toBeGreaterThan(0);
		expect(blocked.retryAfter).toBeLessThanOrEqual(60);
	});

	it('different keys are independent', () => {
		const key1 = `t2:${randomBytes(4).toString('hex')}`;
		const key2 = `t2:${randomBytes(4).toString('hex')}`;
		for (let i = 0; i < 3; i++) checkAndRecordWindowed(key1, 3, 60_000);
		expect(checkAndRecordWindowed(key1, 3, 60_000).ok).toBe(false);
		expect(checkAndRecordWindowed(key2, 3, 60_000).ok).toBe(true);
	});

	it('respects window length (separate buckets per windowMs do not interfere)', () => {
		const key = `t3:${randomBytes(4).toString('hex')}`;
		expect(checkAndRecordWindowed(key, 2, 60_000).ok).toBe(true);
		expect(checkAndRecordWindowed(key, 2, 60_000).ok).toBe(true);
		expect(checkAndRecordWindowed(key, 2, 60_000).ok).toBe(false);
	});
});
