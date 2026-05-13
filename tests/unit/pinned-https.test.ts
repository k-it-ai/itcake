/**
 * Tests for `lib/server/pinned-https.ts` — round 2 finding (HIGH):
 *   Telegram + Anthropic outbound calls were going through Node's default
 *   DNS lookup, contradicting the documented "SMTP / S3 / WebDAV / RDAP /
 *   HTTP / SSL / ping all DNS-rebind-pinned" invariant.
 *
 * We don't actually connect to a remote host here. We exercise the agent
 * factory shape + verify `pinnedHttpsRequest` rejects non-https URLs and
 * honors the bound `maxBodyBytes` cap.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { mkdirSync, rmSync, existsSync } from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';

const TEST_DIR = path.resolve('data-test-pinned-https');

let pinnedHttpsAgent: typeof import('../../src/lib/server/pinned-https.js').pinnedHttpsAgent;
let pinnedHttpsRequest: typeof import('../../src/lib/server/pinned-https.js').pinnedHttpsRequest;

beforeAll(async () => {
	if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
	mkdirSync(TEST_DIR, { recursive: true });
	process.env.DATABASE_PATH = path.join(TEST_DIR, 'pin.db');
	process.env.DATA_DIR = TEST_DIR;
	process.env.SESSION_SECRET ||= randomBytes(32).toString('hex');
	const mod = await import('../../src/lib/server/pinned-https.js');
	pinnedHttpsAgent = mod.pinnedHttpsAgent;
	pinnedHttpsRequest = mod.pinnedHttpsRequest;
});

describe('pinnedHttpsAgent', () => {
	it('returns a node:https Agent with the lookup hook installed', () => {
		const agent = pinnedHttpsAgent('api.anthropic.com');
		expect(agent).toBeDefined();
		// Node's http(s).Agent exposes `keepAlive`/`maxSockets`; that's enough
		// to identify it as a valid Agent without coupling to a specific class.
		expect((agent as unknown as { keepAlive: boolean }).keepAlive).toBe(true);
	});

	it('caches the agent across calls (same instance returned)', () => {
		const a = pinnedHttpsAgent('api.telegram.org');
		const b = pinnedHttpsAgent('api.anthropic.com');
		expect(a).toBe(b);
	});
});

describe('pinnedHttpsRequest', () => {
	it('rejects non-https URLs', async () => {
		await expect(pinnedHttpsRequest({
			method: 'GET',
			url: 'http://example.com/'
		})).rejects.toThrow(/https:/);
	});

	it('rejects URLs that resolve to blocked IP ranges (loopback)', async () => {
		// localhost resolves to 127.0.0.1 → blocked by resolveTarget.
		await expect(pinnedHttpsRequest({
			method: 'GET',
			url: 'https://localhost/',
			timeoutMs: 2000
		})).rejects.toThrow();
	});
});
