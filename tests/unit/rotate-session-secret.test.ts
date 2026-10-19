import { describe, it, expect, beforeAll } from 'vitest';
import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import path from 'node:path';
import { randomBytes, scryptSync, hkdfSync, createCipheriv, createDecipheriv } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import Database from 'better-sqlite3';
import {
	FIELD_ALGORITHM,
	FIELD_KEY_INFO,
	IV_LENGTH,
	KEY_LENGTH,
	MASTER_KEY_SALT,
	MASTER_KEY_SCRYPT_OPTS,
	SALT_LENGTH,
	TAG_LENGTH
} from '../../src/lib/server/field-crypto-params.js';

const TEST_DIR = path.resolve('data-test-secret-rotation');
const SECRET_A = 'a'.repeat(64);
const SECRET_B = 'b'.repeat(64);
const SECRET_WRONG = 'c'.repeat(64);
const SCRIPT_PATH = path.resolve('scripts/rotate-session-secret.mjs');

beforeAll(() => {
	if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
	mkdirSync(TEST_DIR, { recursive: true });
});

// KDF parameters are imported from the SAME module the app and the rotation
// script use. If the script ever hardcodes its own parameters again, the
// blobs seeded below stop decrypting and every rotation test fails.
// (scrypt N=2^17 is deliberately slow — cache per secret.)
const masterCache = new Map<string, Buffer>();
function master(secret: string) {
	let m = masterCache.get(secret);
	if (!m) {
		m = scryptSync(secret, MASTER_KEY_SALT, KEY_LENGTH, MASTER_KEY_SCRYPT_OPTS);
		masterCache.set(secret, m);
	}
	return m;
}
function fieldKey(master: Buffer, salt: Buffer) {
	return Buffer.from(hkdfSync('sha256', master, salt, FIELD_KEY_INFO, KEY_LENGTH));
}
function enc(plain: string, secret: string, aad: string): string {
	const salt = randomBytes(SALT_LENGTH);
	const iv = randomBytes(IV_LENGTH);
	const c = createCipheriv(FIELD_ALGORITHM, fieldKey(master(secret), salt), iv);
	c.setAAD(Buffer.from(aad, 'utf-8'));
	const out = Buffer.concat([c.update(plain, 'utf8'), c.final()]);
	const tag = c.getAuthTag();
	return 'enc3:' + Buffer.concat([salt, iv, tag, out]).toString('base64');
}
function dec(ct: string, secret: string, aad: string): string {
	const buf = Buffer.from(ct.slice('enc3:'.length), 'base64');
	const salt = buf.subarray(0, SALT_LENGTH);
	const iv = buf.subarray(SALT_LENGTH, SALT_LENGTH + IV_LENGTH);
	const tag = buf.subarray(SALT_LENGTH + IV_LENGTH, SALT_LENGTH + IV_LENGTH + TAG_LENGTH);
	const e = buf.subarray(SALT_LENGTH + IV_LENGTH + TAG_LENGTH);
	const d = createDecipheriv(FIELD_ALGORITHM, fieldKey(master(secret), salt), iv);
	d.setAuthTag(tag);
	d.setAAD(Buffer.from(aad, 'utf-8'));
	return Buffer.concat([d.update(e), d.final()]).toString('utf-8');
}
/** Flips one byte inside the ciphertext body, guaranteeing a GCM auth failure. */
function corrupt(ct: string): string {
	const buf = Buffer.from(ct.slice('enc3:'.length), 'base64');
	const i = SALT_LENGTH + IV_LENGTH + TAG_LENGTH + 2;
	buf[i] = buf[i] ^ 0xff;
	return 'enc3:' + buf.toString('base64');
}

function makeTestDb(dbPath: string): Database.Database {
	const db = new Database(dbPath);
	db.exec(`
		CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
		CREATE TABLE agents (id TEXT PRIMARY KEY, hmac_secret TEXT NOT NULL DEFAULT '', data TEXT);
		CREATE TABLE users (id TEXT PRIMARY KEY, totp_secret TEXT);
		CREATE TABLE sessions (id TEXT PRIMARY KEY);
		CREATE TABLE mfa_used_challenges (nonce TEXT PRIMARY KEY);
		CREATE TABLE mfa_step_up_used_codes (code_hash TEXT PRIMARY KEY);
	`);
	return db;
}

function runScript(args: string[]) {
	return spawnSync('node', [SCRIPT_PATH, ...args], { encoding: 'utf-8' });
}

// The script spawns Node and runs real scrypt (N=2^17); give it room.
const SLOW = { timeout: 30_000 };

describe('rotate-session-secret.mjs', () => {
	it('imports the shared KDF parameters instead of hardcoding a copy', () => {
		const src = readFileSync(SCRIPT_PATH, 'utf-8');
		expect(src).toContain('field-crypto-params.js');
		expect(src).toContain('settings-credentials.js');
		// The salt/scrypt opts must come from the module, never inline literals.
		expect(src).not.toMatch(/scryptSync\([^)]*'itcake-master-key-v2'/);
	});

	it('re-wraps every enc3 blob from OLD to NEW', SLOW, () => {
		const dbPath = path.join(TEST_DIR, 'rs.db');
		const db = makeTestDb(dbPath);

		// Seed enc3 ciphertexts encrypted under SECRET_A with app-identical KDF params.
		const smtpPass = enc('smtp-pw-secret', SECRET_A, 'emails.smtp.pass:1');
		const aiKey = enc('sk-ant-real-key', SECRET_A, 'ai.apiKey:1');
		const agentHmac = enc('agent-hmac-key', SECRET_A, 'agent.hmacSecret:a-1');
		const agentRdpPw = enc('rdp-pw', SECRET_A, 'agent.remoteDesktop.password:a-1');
		const userTotp = enc('JBSWY3DPEHPK3PXP', SECRET_A, 'users.totpSecret:u-1');
		const dsn = enc('https://pubkey@sentry.example/1', SECRET_A, 'telemetry.errorReportingDsn:1');

		db.prepare('INSERT INTO settings VALUES (?, ?)').run('emails', JSON.stringify({ smtp: { pass: smtpPass } }));
		db.prepare('INSERT INTO settings VALUES (?, ?)').run('ai', JSON.stringify({ apiKey: aiKey, enabled: true }));
		db.prepare('INSERT INTO settings VALUES (?, ?)').run('telemetry', JSON.stringify({ errorReportingDsn: dsn, sampleRate: 1 }));
		db.prepare("INSERT INTO agents (id, hmac_secret, data) VALUES (?, ?, ?)").run(
			'a-1', agentHmac, JSON.stringify({ remoteDesktop: { password: agentRdpPw } })
		);
		db.prepare('INSERT INTO users (id, totp_secret) VALUES (?, ?)').run('u-1', userTotp);
		db.prepare("INSERT INTO sessions VALUES ('sess-1')").run();
		db.close();

		const res = runScript(['--db', dbPath, '--old', SECRET_A, '--new', SECRET_B]);
		if (res.status !== 0) {
			console.error('script stdout:', res.stdout);
			console.error('script stderr:', res.stderr);
		}
		expect(res.status).toBe(0);
		expect(res.stdout).toContain('Re-wrapped:');

		const db2 = new Database(dbPath);
		const emails = JSON.parse((db2.prepare("SELECT value FROM settings WHERE key='emails'").get() as { value: string }).value);
		const ai = JSON.parse((db2.prepare("SELECT value FROM settings WHERE key='ai'").get() as { value: string }).value);
		const tel = JSON.parse((db2.prepare("SELECT value FROM settings WHERE key='telemetry'").get() as { value: string }).value);
		const a = db2.prepare("SELECT hmac_secret, data FROM agents WHERE id='a-1'").get() as { hmac_secret: string; data: string };
		const u = db2.prepare("SELECT totp_secret FROM users WHERE id='u-1'").get() as { totp_secret: string };
		const sessCount = (db2.prepare('SELECT COUNT(*) AS c FROM sessions').get() as { c: number }).c;
		db2.close();

		// All blobs still enc3, but now decryptable with SECRET_B (not SECRET_A).
		expect(dec(emails.smtp.pass, SECRET_B, 'emails.smtp.pass:1')).toBe('smtp-pw-secret');
		expect(() => dec(emails.smtp.pass, SECRET_A, 'emails.smtp.pass:1')).toThrow();
		expect(dec(ai.apiKey, SECRET_B, 'ai.apiKey:1')).toBe('sk-ant-real-key');
		expect(dec(tel.errorReportingDsn, SECRET_B, 'telemetry.errorReportingDsn:1')).toBe('https://pubkey@sentry.example/1');
		expect(dec(a.hmac_secret, SECRET_B, 'agent.hmacSecret:a-1')).toBe('agent-hmac-key');
		const aData = JSON.parse(a.data);
		expect(dec(aData.remoteDesktop.password, SECRET_B, 'agent.remoteDesktop.password:a-1')).toBe('rdp-pw');
		expect(dec(u.totp_secret, SECRET_B, 'users.totpSecret:u-1')).toBe('JBSWY3DPEHPK3PXP');
		expect(sessCount).toBe(0);
	});

	it('refuses same OLD == NEW', () => {
		const dbPath = path.join(TEST_DIR, 'rs2.db');
		const db = makeTestDb(dbPath);
		db.close();
		const res = runScript(['--db', dbPath, '--old', SECRET_A, '--new', SECRET_A]);
		expect(res.status).not.toBe(0);
		expect(res.stderr).toContain('must differ');
	});

	it('dry-run leaves DB untouched', SLOW, () => {
		const dbPath = path.join(TEST_DIR, 'rs3.db');
		const db = makeTestDb(dbPath);
		const original = enc('keepme', SECRET_A, 'ai.apiKey:1');
		db.prepare('INSERT INTO settings VALUES (?, ?)').run('ai', JSON.stringify({ apiKey: original }));
		db.close();

		const res = runScript(['--db', dbPath, '--old', SECRET_A, '--new', SECRET_B, '--dry-run']);
		expect(res.status).toBe(0);

		const db2 = new Database(dbPath);
		const ai = JSON.parse((db2.prepare("SELECT value FROM settings WHERE key='ai'").get() as { value: string }).value);
		db2.close();
		expect(ai.apiKey).toBe(original);
	});

	it('aborts without writing when --old does not decrypt the DB', SLOW, () => {
		const dbPath = path.join(TEST_DIR, 'rs4.db');
		const db = makeTestDb(dbPath);
		const original = enc('keepme', SECRET_A, 'ai.apiKey:1');
		db.prepare('INSERT INTO settings VALUES (?, ?)').run('ai', JSON.stringify({ apiKey: original }));
		db.close();

		const res = runScript(['--db', dbPath, '--old', SECRET_WRONG, '--new', SECRET_B]);
		expect(res.status).toBe(2);
		expect(res.stderr).toContain('does not decrypt');

		const db2 = new Database(dbPath);
		const ai = JSON.parse((db2.prepare("SELECT value FROM settings WHERE key='ai'").get() as { value: string }).value);
		db2.close();
		expect(ai.apiKey).toBe(original);
	});

	it('rolls back every row when a single blob fails to decrypt', SLOW, () => {
		const dbPath = path.join(TEST_DIR, 'rs5.db');
		const db = makeTestDb(dbPath);
		const goodPass = enc('smtp-pw-secret', SECRET_A, 'emails.smtp.pass:1');
		const brokenKey = corrupt(enc('sk-ant-real-key', SECRET_A, 'ai.apiKey:1'));
		db.prepare('INSERT INTO settings VALUES (?, ?)').run('emails', JSON.stringify({ smtp: { pass: goodPass } }));
		db.prepare('INSERT INTO settings VALUES (?, ?)').run('ai', JSON.stringify({ apiKey: brokenKey }));
		db.close();

		const res = runScript(['--db', dbPath, '--old', SECRET_A, '--new', SECRET_B]);
		expect(res.status).toBe(1);
		expect(res.stdout).toContain('rolled back');
		expect(res.stderr).toContain('failure(s)');

		// The healthy row must NOT have been rotated — the transaction rolled back.
		const db2 = new Database(dbPath);
		const emails = JSON.parse((db2.prepare("SELECT value FROM settings WHERE key='emails'").get() as { value: string }).value);
		const ai = JSON.parse((db2.prepare("SELECT value FROM settings WHERE key='ai'").get() as { value: string }).value);
		db2.close();
		expect(emails.smtp.pass).toBe(goodPass);
		expect(dec(emails.smtp.pass, SECRET_A, 'emails.smtp.pass:1')).toBe('smtp-pw-secret');
		expect(ai.apiKey).toBe(brokenKey);
	});
});

describe('agent token hashes vs. SESSION_SECRET rotation', () => {
	it('keys stored hashes with the per-install pepper, not SESSION_SECRET', SLOW, async () => {
		const { createHmac } = await import('node:crypto');
		const dbPath = path.join(TEST_DIR, 'rs-agent-tokens.db');
		process.env.DATA_DIR = TEST_DIR;
		process.env.DATABASE_PATH = dbPath;

		const auth = await import('../../src/lib/server/agent-auth.js');
		const token = 'f'.repeat(64);
		const stored = auth.hashAgentToken(token);
		const pepper = auth.getAgentTokenPepper();

		// Pre-fix stored === HMAC(SESSION_SECRET, token): rotating the secret
		// locked out every agent (their plaintext tokens only live agent-side).
		expect(stored).not.toBe(createHmac('sha256', process.env.SESSION_SECRET as string).update(token).digest('hex'));
		expect(stored).toBe(createHmac('sha256', pepper).update(token).digest('hex'));

		const db = new Database(dbPath);
		db.prepare("INSERT INTO agents (id, name, hostname, os, arch, token_hash) VALUES ('a-rot', 'host', 'host', 'linux', 'amd64', ?)").run(stored);
		db.prepare("INSERT INTO agent_enrollment_tokens (id, token_hash, name, expires_at) VALUES ('e-rot', ?, 'enroll', '2027-01-01T00:00:00Z')")
			.run(auth.hashAgentToken('e'.repeat(64)));
		db.close();

		const res = runScript(['--db', dbPath, '--old', SECRET_A, '--new', SECRET_B]);
		if (res.status !== 0) console.error('script stderr:', res.stderr);
		expect(res.status).toBe(0);

		const db2 = new Database(dbPath);
		const agentRow = db2.prepare("SELECT token_hash FROM agents WHERE id = 'a-rot'").get() as { token_hash: string };
		const enrollCount = (db2.prepare('SELECT COUNT(*) AS c FROM agent_enrollment_tokens').get() as { c: number }).c;
		const pepperRow = db2.prepare("SELECT value FROM settings WHERE key = 'agentTokenPepper'").get() as { value: string } | undefined;
		db2.close();

		// Hashes are rotation-independent, the pepper (settings) is untouched,
		// and enrollment tokens survive the rotation.
		expect(agentRow.token_hash).toBe(stored);
		expect(enrollCount).toBe(1);
		expect(pepperRow ? JSON.parse(pepperRow.value) : null).toBe(pepper);
	});
});
