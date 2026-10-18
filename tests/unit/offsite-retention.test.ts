/**
 * Off-site backup credential resolution + retention.
 *
 * Regression: credentials read from settings arrive already decrypted
 * (`getSetting()` runs `decryptSettingsFields`), but the previous code threw
 * whenever the value was plaintext in production — so every off-site upload
 * with a configured credential failed in prod. Retention previously did
 * nothing at all: remote backups were never pruned.
 *
 * Loopback is normally blocked by the SSRF guard; the guard module is mocked
 * so the test can point the S3 client at a local fake server.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import http from 'node:http';
import { mkdirSync, rmSync, existsSync } from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';

vi.mock('../../src/lib/server/checks/validate-target.js', async (importOriginal) => {
	const actual = await importOriginal<typeof import('../../src/lib/server/checks/validate-target.js')>();
	return {
		...actual,
		resolveTarget: async () => '127.0.0.1',
		resolveAndValidate: async () => '127.0.0.1'
	};
});

const TEST_DIR = path.resolve('data-test-offsite-retention');
const DAY = 86_400_000;

interface RemoteObject {
	key: string;
	lastModifiedMs: number;
}

let db: typeof import('../../src/lib/server/db.js').db;
let setSetting: typeof import('../../src/lib/server/db.js').setSetting;
let selectExpiredRemoteBackups: typeof import('../../src/services/backup-offsite.js').selectExpiredRemoteBackups;
let runOffsiteBackup: typeof import('../../src/services/backup-offsite.js').runOffsiteBackup;
let resolveOffsiteCredential: typeof import('../../src/services/offsite-credential.js').resolveOffsiteCredential;

const store = new Map<string, { body: Buffer; lastModified: string }>();
const deletes: string[] = [];
let server: http.Server;
let port = 0;

/** Matches REMOTE_BACKUP_NAME: backup-YYYY-MM-DD-HHMMSS.zip */
function backupName(i: number): string {
	return `backup-2026-01-0${i}-00000${i}.zip`;
}

function fakeS3Handler(req: http.IncomingMessage, res: http.ServerResponse): void {
	const url = new URL(req.url ?? '/', 'http://127.0.0.1');
	const key = decodeURIComponent(url.pathname.replace(/^\/[^/]+\/?/, ''));
	if (req.method === 'GET' && url.searchParams.get('list-type') === '2') {
		const prefix = url.searchParams.get('prefix') ?? '';
		const contents = [...store.entries()]
			.filter(([k]) => k.startsWith(prefix))
			.map(([k, v]) => `<Contents><Key>${k}</Key><LastModified>${v.lastModified}</LastModified></Contents>`)
			.join('');
		res.writeHead(200, { 'content-type': 'application/xml' });
		res.end(`<?xml version="1.0"?><ListBucketResult>${contents}</ListBucketResult>`);
		return;
	}
	if (req.method === 'PUT') {
		const chunks: Buffer[] = [];
		req.on('data', (c: Buffer) => chunks.push(c));
		req.on('end', () => {
			store.set(key, { body: Buffer.concat(chunks), lastModified: new Date().toISOString() });
			res.writeHead(200);
			res.end();
		});
		return;
	}
	if (req.method === 'DELETE') {
		deletes.push(key);
		store.delete(key);
		res.writeHead(204);
		res.end();
		return;
	}
	res.writeHead(400);
	res.end();
}

function buildSettings() {
	return {
		enabled: true,
		schedule: 'manual',
		encryptionPassphrase: '',
		offsite: {
			enabled: true,
			schedule: 'manual',
			target: 's3',
			s3: {
				endpoint: `http://127.0.0.1:${port}`,
				region: 'us-east-1',
				bucket: 'bk',
				accessKeyId: 'AK',
				secretAccessKey: 'SK',
				pathPrefix: 'backups/'
			},
			webdav: { url: '', username: '', password: '' },
			retentionDays: 30,
			lastUpload: null
		}
	};
}

beforeAll(async () => {
	if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
	mkdirSync(TEST_DIR, { recursive: true });
	mkdirSync(path.join(TEST_DIR, 'backups'), { recursive: true });
	mkdirSync(path.join(TEST_DIR, 'uploads'), { recursive: true });
	process.env.DATA_DIR = TEST_DIR;
	process.env.DATABASE_PATH = path.join(TEST_DIR, 'offsite.db');
	process.env.SESSION_SECRET ||= randomBytes(32).toString('hex');

	server = http.createServer(fakeS3Handler);
	await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
	port = (server.address() as { port: number }).port;

	const dbMod = await import('../../src/lib/server/db.js');
	db = dbMod.db;
	setSetting = dbMod.setSetting;
	const offsiteMod = await import('../../src/services/backup-offsite.js');
	selectExpiredRemoteBackups = offsiteMod.selectExpiredRemoteBackups;
	runOffsiteBackup = offsiteMod.runOffsiteBackup;
	resolveOffsiteCredential = (await import('../../src/services/offsite-credential.js')).resolveOffsiteCredential;
});

afterAll(() => {
	server.close();
});

describe('resolveOffsiteCredential', () => {
	it('accepts already-decrypted credentials in production (regression)', () => {
		expect(resolveOffsiteCredential('plain-secret', 'production')).toBe('plain-secret');
	});

	it('refuses to ship ciphertext to S3/WebDAV in production', () => {
		expect(() => resolveOffsiteCredential('enc2:AAAA', 'production')).toThrow(/ciphertext/);
	});

	it('decrypts stale ciphertext outside production', async () => {
		const { encryptField } = await import('../../src/lib/server/field-crypto.js');
		const ct = encryptField('dev-secret');
		expect(ct.startsWith('enc')).toBe(true);
		expect(resolveOffsiteCredential(ct, 'development')).toBe('dev-secret');
	});

	it('passes through empty values', () => {
		expect(resolveOffsiteCredential('', 'production')).toBe('');
	});
});

describe('selectExpiredRemoteBackups', () => {
	const now = Date.parse('2026-06-01T00:00:00Z');
	const obj = (name: string, ageDays: number): RemoteObject => ({
		key: 'backups/' + name,
		lastModifiedMs: now - ageDays * DAY
	});

	it('keeps the newest 7 even when all are older than retention', () => {
		const objects = Array.from({ length: 8 }, (_, i) => obj(backupName(i + 1), 30 + i));
		const expired = selectExpiredRemoteBackups(objects, { retentionDays: 30, now });
		expect(expired.map(o => o.key)).toEqual(['backups/' + backupName(8)]);
	});

	it('ignores sentinels and stray files', () => {
		const objects: RemoteObject[] = [
			obj('_itcake-connectivity-test-123.txt', 400),
			obj('notes.txt', 400),
			...Array.from({ length: 8 }, (_, i) => obj(backupName(i + 1), 40 + i))
		];
		const expired = selectExpiredRemoteBackups(objects, { retentionDays: 30, now });
		expect(expired.map(o => o.key)).toEqual(['backups/' + backupName(8)]);
	});

	it('never deletes a backup whose timestamp cannot be parsed', () => {
		const objects: RemoteObject[] = [
			{ key: 'backups/' + backupName(9), lastModifiedMs: Number.NaN },
			...Array.from({ length: 6 }, (_, i) => obj(backupName(i + 1), 60 + i))
		];
		expect(selectExpiredRemoteBackups(objects, { retentionDays: 30, now })).toEqual([]);
	});

	it('keeps recent backups inside retention', () => {
		const objects = Array.from({ length: 9 }, (_, i) => obj(backupName(i + 1), i));
		expect(selectExpiredRemoteBackups(objects, { retentionDays: 30, now })).toEqual([]);
	});

	it('honours custom keepMin and retentionDays', () => {
		const objects = Array.from({ length: 4 }, (_, i) => obj(backupName(i + 1), 10 * i));
		const expired = selectExpiredRemoteBackups(objects, { keepMin: 2, retentionDays: 5, now });
		expect(expired.map(o => o.key)).toEqual(['backups/' + backupName(3), 'backups/' + backupName(4)]);
	});
});

describe('runOffsiteBackup — S3 upload + retention prune', () => {
	it('uploads a backup and deletes only expired remote backups', { timeout: 30_000 }, async () => {
		store.clear();
		deletes.length = 0;

		const nowTs = Date.now();
		// 9 old backups (40..120 days), plus sentinel + stray file, all old.
		for (let i = 0; i < 9; i++) {
			store.set('backups/' + backupName(i + 1), {
				body: Buffer.from('x'),
				lastModified: new Date(nowTs - (40 + i * 10) * DAY).toISOString()
			});
		}
		store.set('backups/_itcake-connectivity-test-1234.txt', { body: Buffer.from('x'), lastModified: new Date(nowTs - 400 * DAY).toISOString() });
		store.set('backups/notes.txt', { body: Buffer.from('x'), lastModified: new Date(nowTs - 400 * DAY).toISOString() });

		setSetting('backup', buildSettings());

		const result = await runOffsiteBackup();
		expect(result.error).toBeUndefined();
		expect(result.ok).toBe(true);

		const uploaded = result.remoteKey as string;
		expect(uploaded.startsWith('backups/backup-')).toBe(true);
		expect(store.has(uploaded)).toBe(true);
		expect((store.get(uploaded) as { body: Buffer }).body.length).toBeGreaterThan(0);

		// 10 backup-named objects (uploaded + 9 seeds): the newest 7 are kept,
		// the remaining 3 (100/110/120 days old) are past retention and deleted.
		expect([...deletes].sort()).toEqual([
			'backups/' + backupName(7),
			'backups/' + backupName(8),
			'backups/' + backupName(9)
		].sort());
		expect(deletes).not.toContain(uploaded);
		expect(store.has('backups/_itcake-connectivity-test-1234.txt')).toBe(true);
		expect(store.has('backups/notes.txt')).toBe(true);
	});
});
