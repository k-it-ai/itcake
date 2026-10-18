import { describe, it, expect, beforeAll } from 'vitest';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';

const TEST_DIR = path.resolve('data-test-disk-usage');

let measureDataDirUsage: typeof import('../../src/lib/server/disk-usage.js').measureDataDirUsage;

beforeAll(async () => {
	if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
	mkdirSync(TEST_DIR, { recursive: true });
	mkdirSync(path.join(TEST_DIR, 'uploads'), { recursive: true });
	mkdirSync(path.join(TEST_DIR, 'backups'), { recursive: true });
	mkdirSync(path.join(TEST_DIR, 'agent-binaries'), { recursive: true });
	mkdirSync(path.join(TEST_DIR, 'recordings'), { recursive: true });
	process.env.DATABASE_PATH = path.join(TEST_DIR, 'du.db');
	process.env.DATA_DIR = TEST_DIR;
	process.env.SESSION_SECRET ||= randomBytes(32).toString('hex');

	writeFileSync(path.join(TEST_DIR, 'uploads', 'one.png'), Buffer.alloc(1000));
	writeFileSync(path.join(TEST_DIR, 'uploads', 'two.png'), Buffer.alloc(2000));
	writeFileSync(path.join(TEST_DIR, 'backups', 'backup-2026-01-01-000000.zip'), Buffer.alloc(5000));
	writeFileSync(path.join(TEST_DIR, 'agent-binaries', 'itcake-agent-linux-amd64'), Buffer.alloc(10000));

	const mod = await import('../../src/lib/server/disk-usage.js');
	measureDataDirUsage = mod.measureDataDirUsage;
});

describe('measureDataDirUsage', () => {
	it('aggregates breakdown by category', () => {
		const r = measureDataDirUsage();
		const get = (n: string) => r.breakdown.find(b => b.name === n);
		expect(get('uploads')).toEqual({ name: 'uploads', bytes: 3000, fileCount: 2 });
		expect(get('backups')).toEqual({ name: 'backups', bytes: 5000, fileCount: 1 });
		expect(get('agent-binaries')).toEqual({ name: 'agent-binaries', bytes: 10000, fileCount: 1 });
		expect(get('recordings')).toEqual({ name: 'recordings', bytes: 0, fileCount: 0 });
	});

	it('totalBytes sums the breakdown', () => {
		const r = measureDataDirUsage();
		const sum = r.breakdown.reduce((acc, b) => acc + b.bytes, 0);
		expect(r.totalBytes).toBe(sum);
		expect(r.totalBytes).toBeGreaterThanOrEqual(18000); // 3k+5k+10k + maybe db file
	});

	it('records measuredAt as an ISO 8601 timestamp', () => {
		const r = measureDataDirUsage();
		expect(r.measuredAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
	});

	it('free space is reported when statfs succeeds (Linux + macOS)', () => {
		const r = measureDataDirUsage();
		// On linux/darwin runners, statfsSync returns a struct.
		if (process.platform === 'linux' || process.platform === 'darwin') {
			expect(r.free).not.toBeNull();
			expect(r.free!.bytes).toBeGreaterThan(0);
			expect(r.free!.percentUsed).toBeGreaterThanOrEqual(0);
			expect(r.free!.percentUsed).toBeLessThanOrEqual(100);
		}
	});
});
