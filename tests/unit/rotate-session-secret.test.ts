import { describe, it, expect, beforeAll } from 'vitest';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { randomBytes, scryptSync, hkdfSync, createCipheriv, createDecipheriv } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import Database from 'better-sqlite3';

const TEST_DIR = path.resolve('data-test-secret-rotation');
const SECRET_A = 'a'.repeat(64);
const SECRET_B = 'b'.repeat(64);

beforeAll(() => {
	if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
	mkdirSync(TEST_DIR, { recursive: true });
});

function master(secret: string) { return scryptSync(secret, 'itcake-master-key-v2', 32); }
function fieldKey(master: Buffer, salt: Buffer) {
	return Buffer.from(hkdfSync('sha256', master, salt, 'itcake-field-encryption', 32));
}
function enc(plain: string, secret: string, aad: string): string {
	const salt = randomBytes(16);
	const iv = randomBytes(12);
	const c = createCipheriv('aes-256-gcm', fieldKey(master(secret), salt), iv);
	c.setAAD(Buffer.from(aad, 'utf-8'));
	const out = Buffer.concat([c.update(plain, 'utf8'), c.final()]);
	const tag = c.getAuthTag();
	return 'enc3:' + Buffer.concat([salt, iv, tag, out]).toString('base64');
}
function dec(ct: string, secret: string, aad: string): string {
	const buf = Buffer.from(ct.slice('enc3:'.length), 'base64');
	const salt = buf.subarray(0, 16);
	const iv = buf.subarray(16, 28);
	const tag = buf.subarray(28, 44);
	const e = buf.subarray(44);
	const d = createDecipheriv('aes-256-gcm', fieldKey(master(secret), salt), iv);
	d.setAuthTag(tag);
	d.setAAD(Buffer.from(aad, 'utf-8'));
	return Buffer.concat([d.update(e), d.final()]).toString('utf-8');
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

describe('rotate-session-secret.mjs', () => {
	it('re-wraps every enc3 blob from OLD to NEW', () => {
		const dbPath = path.join(TEST_DIR, 'rs.db');
		const db = makeTestDb(dbPath);

		// Seed enc3 ciphertexts encrypted under SECRET_A.
		const smtpPass = enc('smtp-pw-secret', SECRET_A, 'emails.smtp.pass:1');
		const aiKey = enc('sk-ant-real-key', SECRET_A, 'ai.apiKey:1');
		const agentHmac = enc('agent-hmac-key', SECRET_A, 'agent.hmacSecret:a-1');
		const agentRdpPw = enc('rdp-pw', SECRET_A, 'agent.remoteDesktop.password:a-1');
		const userTotp = enc('JBSWY3DPEHPK3PXP', SECRET_A, 'users.totpSecret:u-1');

		db.prepare('INSERT INTO settings VALUES (?, ?)').run('emails', JSON.stringify({ smtp: { pass: smtpPass } }));
		db.prepare('INSERT INTO settings VALUES (?, ?)').run('ai', JSON.stringify({ apiKey: aiKey, enabled: true }));
		db.prepare("INSERT INTO agents (id, hmac_secret, data) VALUES (?, ?, ?)").run(
			'a-1', agentHmac, JSON.stringify({ remoteDesktop: { password: agentRdpPw } })
		);
		db.prepare('INSERT INTO users (id, totp_secret) VALUES (?, ?)').run('u-1', userTotp);
		db.prepare("INSERT INTO sessions VALUES ('sess-1')").run();
		db.close();

		const scriptPath = path.resolve('scripts/rotate-session-secret.mjs');
		const res = spawnSync('node', [scriptPath, '--db', dbPath, '--old', SECRET_A, '--new', SECRET_B], { encoding: 'utf-8' });
		if (res.status !== 0) {
			console.error('script stdout:', res.stdout);
			console.error('script stderr:', res.stderr);
		}
		expect(res.status).toBe(0);
		expect(res.stdout).toContain('Re-wrapped:');

		const db2 = new Database(dbPath);
		const emails = JSON.parse((db2.prepare("SELECT value FROM settings WHERE key='emails'").get() as { value: string }).value);
		const ai = JSON.parse((db2.prepare("SELECT value FROM settings WHERE key='ai'").get() as { value: string }).value);
		const a = db2.prepare("SELECT hmac_secret, data FROM agents WHERE id='a-1'").get() as { hmac_secret: string; data: string };
		const u = db2.prepare("SELECT totp_secret FROM users WHERE id='u-1'").get() as { totp_secret: string };
		const sessCount = (db2.prepare('SELECT COUNT(*) AS c FROM sessions').get() as { c: number }).c;
		db2.close();

		// All blobs still enc3, but now decryptable with SECRET_B (not SECRET_A).
		expect(dec(emails.smtp.pass, SECRET_B, 'emails.smtp.pass:1')).toBe('smtp-pw-secret');
		expect(() => dec(emails.smtp.pass, SECRET_A, 'emails.smtp.pass:1')).toThrow();
		expect(dec(ai.apiKey, SECRET_B, 'ai.apiKey:1')).toBe('sk-ant-real-key');
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
		const scriptPath = path.resolve('scripts/rotate-session-secret.mjs');
		const res = spawnSync('node', [scriptPath, '--db', dbPath, '--old', SECRET_A, '--new', SECRET_A], { encoding: 'utf-8' });
		expect(res.status).not.toBe(0);
		expect(res.stderr).toContain('must differ');
	});

	it('dry-run leaves DB untouched', () => {
		const dbPath = path.join(TEST_DIR, 'rs3.db');
		const db = makeTestDb(dbPath);
		const original = enc('keepme', SECRET_A, 'ai.apiKey:1');
		db.prepare('INSERT INTO settings VALUES (?, ?)').run('ai', JSON.stringify({ apiKey: original }));
		db.close();

		const scriptPath = path.resolve('scripts/rotate-session-secret.mjs');
		const res = spawnSync('node', [scriptPath, '--db', dbPath, '--old', SECRET_A, '--new', SECRET_B, '--dry-run'], { encoding: 'utf-8' });
		expect(res.status).toBe(0);

		const db2 = new Database(dbPath);
		const ai = JSON.parse((db2.prepare("SELECT value FROM settings WHERE key='ai'").get() as { value: string }).value);
		db2.close();
		expect(ai.apiKey).toBe(original);
	});
});
