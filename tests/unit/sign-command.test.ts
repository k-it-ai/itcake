import { describe, it, expect, beforeAll } from 'vitest';
import { mkdirSync, rmSync, existsSync } from 'node:fs';
import path from 'node:path';
import crypto, { randomBytes } from 'node:crypto';

// server side: an empty per-agent secret must surface a clear error
const TEST_DIR = path.resolve('data-test-sign-command');

let signCommand: typeof import('../../src/lib/server/agent-auth.js').signCommand;
let signBinaryAdvisory: typeof import('../../src/lib/server/agent-auth.js').signBinaryAdvisory;
let LegacyEnrollmentError: typeof import('../../src/lib/server/agent-auth.js').LegacyEnrollmentError;

beforeAll(async () => {
	if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
	mkdirSync(TEST_DIR, { recursive: true });
	process.env.DATABASE_PATH = path.join(TEST_DIR, 'sign.db');
	process.env.DATA_DIR = TEST_DIR;
	process.env.SESSION_SECRET ||= randomBytes(32).toString('hex');
	const m = await import('../../src/lib/server/agent-auth.js');
	signCommand = m.signCommand;
	signBinaryAdvisory = m.signBinaryAdvisory;
	LegacyEnrollmentError = m.LegacyEnrollmentError;
});

describe('signCommand', () => {
	const SECRET = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
	const ts = '2026-04-29T12:00:00.000Z';

	it('produces a deterministic HMAC-SHA256 over canonical message', () => {
		const sig = signCommand('cmd-1', 'agent-1', 'shell', '{"cmd":"ls"}', ts, SECRET);
		const expected = crypto
			.createHmac('sha256', SECRET)
			.update('cmd-1:agent-1:shell:{"cmd":"ls"}:' + ts)
			.digest('hex');
		expect(sig).toBe(expected);
	});

	it('produces different signatures for different payloads', () => {
		const a = signCommand('cmd-1', 'agent-1', 'shell', '{"cmd":"ls"}', ts, SECRET);
		const b = signCommand('cmd-1', 'agent-1', 'shell', '{"cmd":"rm"}', ts, SECRET);
		expect(a).not.toBe(b);
	});

	it('refuses to sign for legacy agents (empty secret) with LegacyEnrollmentError', () => {
		expect(() => signCommand('c', 'a', 'shell', '{}', ts, '')).toThrow(LegacyEnrollmentError);
	});
});

describe('signBinaryAdvisory', () => {
	const SECRET = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
	const HASH = 'a'.repeat(64);
	const ISSUED = '2026-04-29T12:00:00.000Z';

	it('produces deterministic HMAC-SHA256 over canonical message', () => {
		const sig = signBinaryAdvisory('agent-1', HASH, ISSUED, SECRET);
		const expected = crypto
			.createHmac('sha256', SECRET)
			.update(`binary-advisory:agent-1:${HASH}:${ISSUED}`)
			.digest('hex');
		expect(sig).toBe(expected);
	});

	it('binds advisory to agent id (different agent → different sig)', () => {
		const a = signBinaryAdvisory('agent-1', HASH, ISSUED, SECRET);
		const b = signBinaryAdvisory('agent-2', HASH, ISSUED, SECRET);
		expect(a).not.toBe(b);
	});

	it('binds advisory to binary hash (different hash → different sig)', () => {
		const a = signBinaryAdvisory('agent-1', HASH, ISSUED, SECRET);
		const b = signBinaryAdvisory('agent-1', 'b'.repeat(64), ISSUED, SECRET);
		expect(a).not.toBe(b);
	});

	it('refuses to sign for legacy agents (empty secret) with LegacyEnrollmentError — same fail-mode as signCommand so future callers without the existence guard fail noisily', () => {
		expect(() => signBinaryAdvisory('agent-1', HASH, ISSUED, '')).toThrow(LegacyEnrollmentError);
	});
});
