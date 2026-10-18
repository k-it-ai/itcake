/**
 * Tests for `lib/server/pinned-https.ts` — round 2 finding (HIGH):
 *   Telegram + Anthropic outbound calls were going through Node's default
 *   DNS lookup, contradicting the documented "SMTP / RDAP /
 *   HTTP / SSL / ping all DNS-rebind-pinned" invariant.
 *
 * We don't actually connect to a remote host here. We verify
 * `pinnedHttpsRequest` rejects non-https URLs and rejects hostnames that
 * resolve to blocked IP ranges.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { mkdirSync, rmSync, existsSync } from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';

const TEST_DIR = path.resolve('data-test-pinned-https');

let pinnedHttpsRequest: typeof import('../../src/lib/server/pinned-https.js').pinnedHttpsRequest;

beforeAll(async () => {
	if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
	mkdirSync(TEST_DIR, { recursive: true });
	process.env.DATABASE_PATH = path.join(TEST_DIR, 'pin.db');
	process.env.DATA_DIR = TEST_DIR;
	process.env.SESSION_SECRET ||= randomBytes(32).toString('hex');
	const mod = await import('../../src/lib/server/pinned-https.js');
	pinnedHttpsRequest = mod.pinnedHttpsRequest;
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
