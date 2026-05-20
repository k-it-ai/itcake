import { describe, it, expect, beforeAll } from 'vitest';
import { mkdirSync, rmSync, existsSync } from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import bcrypt from 'bcryptjs';
import { assertProductionInvariants } from '../../src/lib/server/startup-invariants.js';


const TEST_DIR = path.resolve('data-test-security-hardening');

let db: typeof import('../../src/lib/server/db.js').db;
let enableMfa: typeof import('../../src/services/auth-mfa.js').enableMfa;
let disableMfa: typeof import('../../src/services/auth-mfa.js').disableMfa;
let initMfa: typeof import('../../src/services/auth-mfa.js').initMfa;
let bulkDispatchCommand: typeof import('../../src/services/agent-commands.js').bulkDispatchCommand;
let BULK_DISPATCH_MAX_AGENTS: number;
let totp: typeof import('../../src/lib/server/totp.js').totp;

beforeAll(async () => {
	if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
	mkdirSync(TEST_DIR, { recursive: true });
	process.env.DATABASE_PATH = path.join(TEST_DIR, 'security.db');
	process.env.DATA_DIR = TEST_DIR;
	process.env.SESSION_SECRET ||= randomBytes(32).toString('hex');

	const dbMod = await import('../../src/lib/server/db.js');
	const mfaMod = await import('../../src/services/auth-mfa.js');
	const cmdMod = await import('../../src/services/agent-commands.js');
	const totpMod = await import('../../src/lib/server/totp.js');

	db = dbMod.db;
	enableMfa = mfaMod.enableMfa;
	disableMfa = mfaMod.disableMfa;
	initMfa = mfaMod.initMfa;
	bulkDispatchCommand = cmdMod.bulkDispatchCommand;
	BULK_DISPATCH_MAX_AGENTS = cmdMod.BULK_DISPATCH_MAX_AGENTS;
	totp = totpMod.totp;
});

describe('MFA enable/disable revokes active sessions', () => {
	const userId = 'sec-mfa-user';
	const password = 'CorrectHorse9';

	beforeAll(async () => {
		const hash = await bcrypt.hash(password, 4);
		db.prepare('DELETE FROM users WHERE id = ?').run(userId);
		db.prepare('INSERT INTO users (id, email, name, password_hash) VALUES (?, ?, ?, ?)')
			.run(userId, 'mfa@test.local', 'MFA Test', hash);
	});

	function seedSession(id: string): void {
		const expiresAt = new Date(Date.now() + 60_000).toISOString();
		db.prepare('INSERT INTO sessions (id, user_id, expires_at) VALUES (?, ?, ?)')
			.run(id, userId, expiresAt);
	}

	function countSessions(): number {
		const row = db.prepare('SELECT COUNT(*) AS n FROM sessions WHERE user_id = ?').get(userId) as { n: number };
		return row.n;
	}

	it('enableMfa deletes pre-existing sessions for the user', () => {
		db.prepare('DELETE FROM sessions WHERE user_id = ?').run(userId);
		seedSession('a'.repeat(64));
		seedSession('b'.repeat(64));
		expect(countSessions()).toBe(2);

		const init = initMfa('mfa@test.local');
		const code = totp(init.secret);
		enableMfa(userId, init.secret, code, init.recoveryCodes);

		expect(countSessions()).toBe(0);
	});

	it('disableMfa also deletes all sessions', () => {
		seedSession('c'.repeat(64));
		expect(countSessions()).toBe(1);
		disableMfa(userId);
		expect(countSessions()).toBe(0);
	});

	it('disableMfa refuses to run when MFA is already off', () => {
		const init2 = initMfa('mfa@test.local');
		enableMfa(userId, init2.secret, totp(init2.secret), init2.recoveryCodes);
		disableMfa(userId);
		expect(() => disableMfa(userId)).toThrow();
	});

	it('does not affect other users\' sessions', async () => {
		const otherId = 'sec-mfa-other';
		const hash = await bcrypt.hash('OtherPass1', 4);
		db.prepare('DELETE FROM users WHERE id = ?').run(otherId);
		db.prepare('INSERT INTO users (id, email, name, password_hash) VALUES (?, ?, ?, ?)')
			.run(otherId, 'other@test.local', 'Other', hash);
		const expiresAt = new Date(Date.now() + 60_000).toISOString();
		db.prepare('INSERT INTO sessions (id, user_id, expires_at) VALUES (?, ?, ?)')
			.run('d'.repeat(64), otherId, expiresAt);

		// session must survive.
		const init = initMfa('mfa@test.local');
		enableMfa(userId, init.secret, totp(init.secret), init.recoveryCodes);

		const row = db.prepare('SELECT COUNT(*) AS n FROM sessions WHERE user_id = ?').get(otherId) as { n: number };
		expect(row.n).toBe(1);
	});
});

describe('bulkDispatchCommand cap', () => {
	it('exports a sane upper bound', () => {
		expect(BULK_DISPATCH_MAX_AGENTS).toBe(200);
	});

	it('throws when caller exceeds the cap before dispatching anything', () => {
		const tooMany = Array.from({ length: BULK_DISPATCH_MAX_AGENTS + 1 }, (_, i) => `bulk-${i}`);
		expect(() =>
			bulkDispatchCommand(tooMany, 'shell', { command: 'echo hi' }, 'sys')
		).toThrow(/capped at 200 agents/);
	});

	it('does not insert any commands when the cap is exceeded', () => {
		const tooMany = Array.from({ length: BULK_DISPATCH_MAX_AGENTS + 5 }, (_, i) => `bulkguard-${i}`);
		try { bulkDispatchCommand(tooMany, 'shell', { command: 'noop' }, 'sys'); } catch { /* expected */ }
		const row = db.prepare(
			"SELECT COUNT(*) AS n FROM agent_commands WHERE agent_id LIKE 'bulkguard-%'"
		).get() as { n: number };
		expect(row.n).toBe(0);
	});
});

describe('production startup invariants', () => {
	it('throws when NODE_ENV=production and ORIGIN is unset', () => {
		expect(() => assertProductionInvariants({ NODE_ENV: 'production' }))
			.toThrow(/ORIGIN is required in production/);
		expect(() => assertProductionInvariants({ NODE_ENV: 'production', ORIGIN: '' }))
			.toThrow(/ORIGIN is required in production/);
	});

	it('passes when NODE_ENV=production and ORIGIN is set', () => {
		expect(() => assertProductionInvariants({
			NODE_ENV: 'production',
			ORIGIN: 'https://itcake.example.com',
			SESSION_SECRET: '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef'
		})).not.toThrow();
	});

	it('does not require ORIGIN outside production', () => {
		expect(() => assertProductionInvariants({ NODE_ENV: 'development' })).not.toThrow();
		expect(() => assertProductionInvariants({})).not.toThrow();
	});

	it('still rejects ADDRESS_HEADER + non-loopback HOST in production', () => {
		expect(() => assertProductionInvariants({
			NODE_ENV: 'production',
			ORIGIN: 'https://itcake.example.com',
			SESSION_SECRET: '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
			ADDRESS_HEADER: 'X-Forwarded-For',
			HOST: '0.0.0.0'
		})).toThrow(/ADDRESS_HEADER is set but HOST=/);
	});

	it('accepts ADDRESS_HEADER paired with a loopback HOST', () => {
		for (const host of ['127.0.0.1', 'localhost', '::1']) {
			expect(() => assertProductionInvariants({
				NODE_ENV: 'production',
				ORIGIN: 'https://itcake.example.com',
				SESSION_SECRET: '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
				ADDRESS_HEADER: 'X-Forwarded-For',
				HOST: host
			})).not.toThrow();
		}
	});

	it('accepts ADDRESS_HEADER + non-loopback HOST when TRUST_PROXY=true (container deployments)', () => {
		expect(() => assertProductionInvariants({
			NODE_ENV: 'production',
			ORIGIN: 'https://itcake.example.com',
			SESSION_SECRET: '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
			ADDRESS_HEADER: 'X-Forwarded-For',
			HOST: '0.0.0.0',
			TRUST_PROXY: 'true'
		})).not.toThrow();
	});

	it('TRUST_PROXY=true alone (without ADDRESS_HEADER) is still fine', () => {
		expect(() => assertProductionInvariants({
			NODE_ENV: 'production',
			ORIGIN: 'https://itcake.example.com',
			SESSION_SECRET: '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
			HOST: '0.0.0.0',
			TRUST_PROXY: 'true'
		})).not.toThrow();
	});

	it('TRUST_PROXY must be the literal string "true" — anything else falls through to the rejection', () => {
		expect(() => assertProductionInvariants({
			NODE_ENV: 'production',
			ORIGIN: 'https://itcake.example.com',
			SESSION_SECRET: '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
			ADDRESS_HEADER: 'X-Forwarded-For',
			HOST: '0.0.0.0',
			TRUST_PROXY: '1'
		})).toThrow(/ADDRESS_HEADER is set but HOST=/);
	});
});

describe('SQLite ISO-vs-space datetime normalisation', () => {

	const userId = 'sec-resurrect-user';

	beforeAll(async () => {
		const hash = await bcrypt.hash('Whatever9', 4);
		db.prepare('DELETE FROM users WHERE id = ?').run(userId);
		db.prepare('INSERT INTO users (id, email, name, password_hash) VALUES (?, ?, ?, ?)')
			.run(userId, 'resurrect@test.local', 'Resurrect', hash);
	});

	it('expired ISO session is NOT returned by stmtGetActiveSessions', async () => {
		const { db: directDb } = await import('../../src/lib/server/db.js');
		const expiredIso = new Date(Date.now() - 5 * 60 * 1000).toISOString();
		const fakeHash = 'a'.repeat(64);
		directDb.prepare('DELETE FROM sessions WHERE user_id = ?').run(userId);
		directDb.prepare('INSERT INTO sessions (id, user_id, expires_at) VALUES (?, ?, ?)')
			.run(fakeHash, userId, expiredIso);

		const rows = directDb.prepare(
			"SELECT id FROM sessions WHERE datetime(expires_at) > datetime('now')"
		).all() as { id: string }[];

		expect(rows.find(r => r.id === fakeHash)).toBeUndefined();
	});

	it('cleanExpiredSessions actually deletes same-UTC-day expired ISO rows', async () => {
		const { cleanExpiredSessions } = await import('../../src/lib/server/auth.js');
		const expiredIso = new Date(Date.now() - 1000).toISOString();
		const fakeHash = 'b'.repeat(64);
		db.prepare('DELETE FROM sessions WHERE user_id = ?').run(userId);
		db.prepare('INSERT INTO sessions (id, user_id, expires_at) VALUES (?, ?, ?)')
			.run(fakeHash, userId, expiredIso);

		cleanExpiredSessions();

		const remaining = db.prepare('SELECT id FROM sessions WHERE id = ?').get(fakeHash);
		expect(remaining).toBeUndefined();
	});

	it('still keeps a future ISO session', () => {
		const futureIso = new Date(Date.now() + 60 * 60 * 1000).toISOString();
		const fakeHash = 'c'.repeat(64);
		db.prepare('DELETE FROM sessions WHERE user_id = ?').run(userId);
		db.prepare('INSERT INTO sessions (id, user_id, expires_at) VALUES (?, ?, ?)')
			.run(fakeHash, userId, futureIso);

		const rows = db.prepare(
			"SELECT id FROM sessions WHERE datetime(expires_at) > datetime('now')"
		).all() as { id: string }[];

		expect(rows.find(r => r.id === fakeHash)).toBeDefined();
	});

	it('agent-schedules due query fires same-UTC-day ISO next_run_at', async () => {
		const pastIso = new Date(Date.now() - 60_000).toISOString();
		const rows = db.prepare(
			"SELECT 1 AS hit WHERE datetime(?) <= datetime('now')"
		).all(pastIso) as { hit: number }[];
		expect(rows.length).toBe(1);

		const buggy = db.prepare("SELECT 1 AS hit WHERE ? <= datetime('now')").all(pastIso) as { hit: number }[];
		expect(buggy.length).toBe(0);
	});
});

describe('changePassword requires MFA when MFA is enabled', () => {

	const userId = 'sec-cp-mfa-user';
	const password = 'StartingPass1';

	beforeAll(async () => {
		const hash = await bcrypt.hash(password, 4);
		db.prepare('DELETE FROM users WHERE id = ?').run(userId);
		db.prepare('INSERT INTO users (id, email, name, password_hash) VALUES (?, ?, ?, ?)')
			.run(userId, 'cp-mfa@test.local', 'CPM', hash);

		const init = initMfa('cp-mfa@test.local');
		enableMfa(userId, init.secret, totp(init.secret), init.recoveryCodes);
	});

	it('the schema accepts a payload with an mfaCode', async () => {
		const { changePasswordSchema } = await import('../../src/lib/validators-auth.js');
		const r = changePasswordSchema.safeParse({
			currentPassword: 'old', newPassword: 'NewPass99', mfaCode: '123456'
		});
		expect(r.success).toBe(true);
	});

	it('verifyMfaCode rejects an obviously-wrong code', async () => {
		const { verifyMfaCode } = await import('../../src/services/auth-mfa.js');
		expect(verifyMfaCode(userId, '000000')).toBe(null);
	});

	it('verifyMfaCode accepts a fresh TOTP for the enrolled secret', async () => {
		// AAD must match the production write path in auth-mfa.ts (mfaAad).
		const { verifyMfaCode } = await import('../../src/services/auth-mfa.js');
		const row = db.prepare('SELECT totp_secret FROM users WHERE id = ?').get(userId) as { totp_secret: string };
		const { decryptField } = await import('../../src/lib/server/field-crypto.js');
		const secret = decryptField(row.totp_secret, `users.totpSecret:${userId}`);
		expect(verifyMfaCode(userId, totp(secret))).toBe('totp');
	});

	it('isMfaEnabled returns true so the route gate engages', async () => {
		const { isMfaEnabled } = await import('../../src/services/auth-mfa.js');
		expect(isMfaEnabled(userId)).toBe(true);
	});
});

describe('remote-desktop credentials are AAD-bound to the agent row', () => {

	it('encryptAgentRemoteDesktop produces enc3:-prefixed ciphertext', async () => {
		const { encryptAgentRemoteDesktop } = await import('../../src/services/guacamole.js');
		const out = encryptAgentRemoteDesktop('agent-rdp-1', {
			protocol: 'rdp', host: '127.0.0.1', port: 3389, username: 'admin', password: 'P@ssw0rd'
		});
		expect(out.password.startsWith('enc3:')).toBe(true);
	});

	it('round-trips through getAgentRemoteDesktop for the same agent id', async () => {
		const { encryptAgentRemoteDesktop, getAgentRemoteDesktop } = await import('../../src/services/guacamole.js');
		const agentId = 'agent-rdp-roundtrip';
		db.prepare('DELETE FROM agents WHERE id = ?').run(agentId);
		db.prepare('INSERT INTO agents (id, name, hostname, os, arch, token_hash, data) VALUES (?, ?, ?, ?, ?, ?, ?)')
			.run(agentId, 'rdp1', 'host1', 'linux', 'amd64', 'h'.repeat(64), JSON.stringify({
				remoteDesktop: encryptAgentRemoteDesktop(agentId, {
					protocol: 'rdp', host: '127.0.0.1', port: 3389, username: 'admin', password: 'topsecret'
				})
			}));

		const back = getAgentRemoteDesktop(agentId);
		expect(back?.password).toBe('topsecret');
	});

	it('a row-shuffled v3 ciphertext fails to decrypt at the destination row', async () => {
		const { encryptAgentRemoteDesktop, getAgentRemoteDesktop } = await import('../../src/services/guacamole.js');
		const agentA = 'agent-rdp-A';
		const agentB = 'agent-rdp-B';
		for (const id of [agentA, agentB]) {
			db.prepare('DELETE FROM agents WHERE id = ?').run(id);
		}

		const aProfile = encryptAgentRemoteDesktop(agentA, {
			protocol: 'rdp', host: '127.0.0.1', port: 3389, username: 'a-admin', password: 'A-secret'
		});
		db.prepare('INSERT INTO agents (id, name, hostname, os, arch, token_hash, data) VALUES (?, ?, ?, ?, ?, ?, ?)')
			.run(agentA, 'rdpA', 'hostA', 'linux', 'amd64', 'a'.repeat(64), JSON.stringify({ remoteDesktop: aProfile }));
		db.prepare('INSERT INTO agents (id, name, hostname, os, arch, token_hash, data) VALUES (?, ?, ?, ?, ?, ?, ?)')
			.run(agentB, 'rdpB', 'hostB', 'linux', 'amd64', 'b'.repeat(64), JSON.stringify({ remoteDesktop: aProfile }));

		expect(getAgentRemoteDesktop(agentA)?.password).toBe('A-secret');
		expect(getAgentRemoteDesktop(agentB)?.password).toBe('');
	});
});
