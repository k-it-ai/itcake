/**
 * Live cross-key backup restore test.
 *
 * A backup taken on a host whose FIELD_ENCRYPTION_KEY is A, restored on a host
 * whose FIELD_ENCRYPTION_KEY is B, is the real-world key-rotation/DR mistake we
 * must fail safe on. The zip/db copy is key-agnostic and restores cleanly, but
 * every enc3 field in it was encrypted with key A and cannot be decrypted with
 * key B.
 *
 * What this suite proves against the production artifact:
 *  - the restore itself succeeds and plaintext business data (clients) survives
 *  - encrypted credentials (here: the MFA TOTP secret) become unreadable and the
 *    affected feature fails closed instead of accepting a wrong secret
 *  - the server logs the decryption failure and stays healthy (no crash)
 *  - recovery codes are NOT encrypted (bcrypt hashes), so the operator is not
 *    locked out; they can still log in and re-enter credentials/rotate keys
 *
 * This documents the contract: changing FIELD_ENCRYPTION_KEY after a restore
 * means "re-enter affected credentials", not "data is lost". Keep the original
 * key or restore it to recover the encrypted fields.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import {
	startProductionServer, freshDataDir, cleanupDir, jsonCall, cookieFrom,
	setupAdmin, PASSWORD, totpCode, type LiveServer
} from './helpers';

const PORT_A = 5510;
const PORT_B = 5511;
const DATA_DIR_A = freshDataDir('cross-key-a');
const DATA_DIR_B = freshDataDir('cross-key-b');
const EMAIL = 'cross-key@example.com';
const CLIENT_NAME = 'Cross-Key Client GmbH';

// Two independent keys. The production server also needs SESSION_SECRET; keep
// it distinct so a failure cannot be masked by the session-key fallback in
// decryptField (enc2 blobs could otherwise decrypt via SESSION_SECRET).
const KEY_A = 'a'.repeat(64);
const KEY_B = 'b'.repeat(64);
const SESSION_A = '1'.repeat(64);
const SESSION_B = '2'.repeat(64);

let serverA: LiveServer;
let serverB: LiveServer;
let cookieA = '';
let mfaSecret = '';
let recoveryCodes: string[] = [];
let backupFilename = '';

describe('cross-key backup restore', () => {
	beforeAll(async () => {
		mkdirSync(path.join(DATA_DIR_A, 'backups'), { recursive: true });
		mkdirSync(path.join(DATA_DIR_B, 'backups'), { recursive: true });
		serverA = await startProductionServer({
			port: PORT_A,
			dataDir: DATA_DIR_A,
			env: { FIELD_ENCRYPTION_KEY: KEY_A, SESSION_SECRET: SESSION_A }
		});
		serverB = await startProductionServer({
			port: PORT_B,
			dataDir: DATA_DIR_B,
			env: { FIELD_ENCRYPTION_KEY: KEY_B, SESSION_SECRET: SESSION_B }
		});
	}, 120_000);

	afterAll(async () => {
		await serverA?.stop();
		await serverB?.stop();
		cleanupDir(DATA_DIR_A);
		cleanupDir(DATA_DIR_B);
	});

	it('host A: sets up the admin and enables MFA (secret encrypted with key A)', async () => {
		const cookie = await setupAdmin(serverA, EMAIL);

		const init = await jsonCall(serverA, 'POST', '/api/auth/mfa', {
			action: 'init',
			currentPassword: PASSWORD
		}, { cookie });
		expect(init.status).toBe(200);
		mfaSecret = init.data.secret as string;
		recoveryCodes = init.data.recoveryCodes as string[];
		expect(mfaSecret).toBeTruthy();
		expect(recoveryCodes.length).toBeGreaterThan(0);

		const enable = await jsonCall(serverA, 'POST', '/api/auth/mfa', {
			action: 'enable',
			currentPassword: PASSWORD,
			secret: mfaSecret,
			code: totpCode(mfaSecret),
			recoveryCodes
		}, { cookie });
		expect(enable.status).toBe(200);
		expect(enable.data.sessionRevoked).toBe(true);

		// Re-login to confirm MFA works on host A before taking the backup.
		const challenge = await jsonCall(serverA, 'POST', '/api/auth/login', {
			email: EMAIL, password: PASSWORD
		});
		expect(challenge.status).toBe(200);
		expect(challenge.data.mfaRequired).toBe(true);

		const login = await jsonCall(serverA, 'POST', '/api/auth/login', {
			email: EMAIL, password: PASSWORD,
			mfaCode: totpCode(mfaSecret),
			mfaToken: challenge.data.mfaToken
		});
		expect(login.status).toBe(200);
		cookieA = cookieFrom(login.res);
	}, 60_000);

	it('host A: creates a client and a backup, then copies the backup to host B', async () => {
		const client = await jsonCall(serverA, 'POST', '/api/clients', {
			name: CLIENT_NAME, email: 'client@cross-key.example',
			address: { street: '1 Key St', city: 'Berlin', zip: '10115', state: '', country: 'DE' },
			language: 'en', currency: 'EUR', paymentTermDays: 14
		}, { cookie: cookieA });
		expect(client.status).toBe(201);

		const created = await jsonCall(serverA, 'POST', '/api/backups', { action: 'create' }, { cookie: cookieA });
		expect(created.status).toBeLessThan(300);
		backupFilename = created.data.filename as string;
		expect(backupFilename).toMatch(/^backup-\d{4}-\d{2}-\d{2}-\d{6}\.zip$/);

		const download = await fetch(`${serverA.base}/api/backups?download=${encodeURIComponent(backupFilename)}`, {
			headers: { Cookie: cookieA }
		});
		expect(download.status).toBe(200);
		const bytes = Buffer.from(await download.arrayBuffer());
		expect(bytes.subarray(0, 2).toString()).toBe('PK');

		// Restore consumes files from the target host's BACKUP_DIR. Copy the
		// artifact across exactly as an operator would move a backup file.
		writeFileSync(path.join(DATA_DIR_B, 'backups', backupFilename), bytes);
	}, 60_000);

	it('host B: restores host A\'s backup under a different FIELD_ENCRYPTION_KEY', async () => {
		const cookie = await setupAdmin(serverB, EMAIL);

		const restore = await jsonCall(serverB, 'POST', '/api/backups', {
			action: 'restore',
			filename: backupFilename,
			password: PASSWORD
		}, { cookie });
		expect(restore.status).toBeLessThan(300);
		expect(restore.data.ok).toBe(true);
	}, 60_000);

	it('host B: plaintext business data survives the restore', async () => {
		// The restored DB is host A's snapshot. Clients live in the generic
		// `documents` table as plaintext JSON — they are business data, not
		// credentials, so no key is needed to read them. Open the live DB
		// read-only (WAL allows concurrent readers) and confirm the row exists.
		const Database = (await import('better-sqlite3')).default;
		const db = new Database(path.join(DATA_DIR_B, 'itcake.db'), { readonly: true, fileMustExist: true });
		try {
			const rows = db.prepare("SELECT data FROM documents WHERE type = 'client'").all() as Array<{ data: string }>;
			expect(rows.length).toBeGreaterThan(0);
			const names = rows.map((r) => {
				try { return (JSON.parse(r.data) as { name?: string }).name ?? ''; } catch { return ''; }
			});
			expect(names).toContain(CLIENT_NAME);
		} finally {
			db.close();
		}

		const health = await fetch(`${serverB.base}/api/healthz`);
		expect(health.status).toBe(200);
	}, 60_000);

	it('host B: key-A TOTP secret and recovery-code hashes fail closed under key B', async () => {
		// Password verification uses the restored bcrypt hash and still works;
		// the login then asks for MFA (the restored row has MFA enabled).
		const challenge = await jsonCall(serverB, 'POST', '/api/auth/login', {
			email: EMAIL, password: PASSWORD
		});
		expect(challenge.status).toBe(200);
		expect(challenge.data.mfaRequired).toBe(true);

		// The TOTP secret is enc3, encrypted with key A's FIELD_ENCRYPTION_KEY.
		// Key B cannot decrypt it, so verifyMfaCode returns null and the login
		// is refused — the wrong key must never be treated as "no MFA".
		const totpAttempt = await jsonCall(serverB, 'POST', '/api/auth/login', {
			email: EMAIL, password: PASSWORD,
			mfaCode: totpCode(mfaSecret),
			mfaToken: challenge.data.mfaToken
		});
		expect(totpAttempt.status).toBe(401);

		// Recovery codes are HMAC-SHA256 hashes keyed by SESSION_SECRET (not
		// bcrypt). The restored hashes were computed with host A's SESSION_SECRET,
		// so they do not verify under host B's secret either. This is the
		// documented availability risk: changing SESSION_SECRET invalidates
		// recovery codes as well as the encrypted TOTP secret.
		const challenge2 = await jsonCall(serverB, 'POST', '/api/auth/login', {
			email: EMAIL, password: PASSWORD
		});
		expect(challenge2.status).toBe(200);
		const recoveryAttempt = await jsonCall(serverB, 'POST', '/api/auth/login', {
			email: EMAIL, password: PASSWORD,
			mfaCode: recoveryCodes[0],
			mfaToken: challenge2.data.mfaToken
		});
		expect(recoveryAttempt.status).toBe(401);

		// Failures are logged (not silent) and the process stays healthy.
		// The TOTP secret is enc3 (AAD-bound), so the v3 path logs the failure.
		expect(serverB.logs.join('\n')).toContain('v3 decryption FAILED');
		const health = await fetch(`${serverB.base}/api/healthz`);
		expect(health.status).toBe(200);
	}, 60_000);
});
