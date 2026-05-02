import { describe, it, expect, beforeAll } from 'vitest';
import { mkdirSync, rmSync, existsSync } from 'node:fs';
import path from 'node:path';
import crypto, { randomBytes } from 'node:crypto';

// server side: an empty per-agent secret must surface a clear error
const TEST_DIR = path.resolve('data-test-sign-command');

let signCommand: typeof import('../../src/lib/server/agent-auth.js').signCommand;
let LegacyEnrollmentError: typeof import('../../src/lib/server/agent-auth.js').LegacyEnrollmentError;

beforeAll(async () => {
	if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
	mkdirSync(TEST_DIR, { recursive: true });
	process.env.DATABASE_PATH = path.join(TEST_DIR, 'sign.db');
	process.env.DATA_DIR = TEST_DIR;
	process.env.SESSION_SECRET ||= randomBytes(32).toString('hex');
	const m = await import('../../src/lib/server/agent-auth.js');
	signCommand = m.signCommand;
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
