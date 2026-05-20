import { describe, it, expect, beforeAll } from 'vitest';
import { existsSync, mkdirSync, rmSync } from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';

const TEST_DIR = path.resolve('data-test-healthz');

let GET: typeof import('../../src/routes/api/healthz/+server.js').GET;

beforeAll(async () => {
	if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
	mkdirSync(TEST_DIR, { recursive: true });
	process.env.DATABASE_PATH = path.join(TEST_DIR, 'hz.db');
	process.env.DATA_DIR = TEST_DIR;
	process.env.SESSION_SECRET ||= randomBytes(32).toString('hex');
	const mod = await import('../../src/routes/api/healthz/+server.js');
	GET = mod.GET;
});

function makeEvent(): Parameters<typeof GET>[0] {
	const url = new URL('http://localhost/api/healthz');
	return { url, request: new Request(url), cookies: {}, locals: {}, params: {} } as unknown as Parameters<typeof GET>[0];
}

describe('GET /api/healthz', () => {
	it('reports ok with component breakdown when subsystems healthy', async () => {
		const res = await GET(makeEvent());
		expect(res.status).toBe(200);
		expect(res.headers.get('cache-control')).toBe('no-store');
		const body = await res.json();
		expect(body.status).toBe('ok');
		expect(Array.isArray(body.components)).toBe(true);
		const names = body.components.map((c: { name: string }) => c.name);
		expect(names).toContain('database');
		expect(names).toContain('disk');
		expect(names).toContain('puppeteer');
	});

	it('returns 503 once shutdown begins', async () => {
		const { _runShutdownForTests, _resetShutdownForTests } = await import('../../src/lib/server/shutdown.js');
		_resetShutdownForTests();
		// Register a no-op so isShuttingDown flips immediately.
		const { registerShutdownTask } = await import('../../src/lib/server/shutdown.js');
		registerShutdownTask('noop', () => {});
		const shutdown = _runShutdownForTests();
		const res = await GET(makeEvent());
		await shutdown;
		expect(res.status).toBe(503);
		const body = await res.json();
		expect(body.status).toBe('unhealthy');
		expect(body.components.some((c: { name: string }) => c.name === 'shutdown')).toBe(true);
		_resetShutdownForTests();
	});
});
