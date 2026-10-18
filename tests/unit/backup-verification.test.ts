import { describe, it, expect, beforeAll } from 'vitest';
import { mkdirSync, rmSync, existsSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';

const TEST_DIR = path.resolve('data-test-backup-verification');

let createBackup: typeof import('../../src/services/backups.js').createBackup;
let verifyBackupIntegrity: typeof import('../../src/services/backup-verification.js').verifyBackupIntegrity;
let runBackupTestRestore: typeof import('../../src/services/backup-verification.js').runBackupTestRestore;
let computeReadinessScore: typeof import('../../src/services/backup-verification.js').computeReadinessScore;
let pickWeeklyTestRestoreCandidate: typeof import('../../src/services/backup-verification.js').pickWeeklyTestRestoreCandidate;
let getRecoveryReadiness: typeof import('../../src/services/backup-verification.js').getRecoveryReadiness;
let listBackupVerifications: typeof import('../../src/services/backup-verification.js').listBackupVerifications;

beforeAll(async () => {
	if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
	mkdirSync(TEST_DIR, { recursive: true });
	mkdirSync(path.join(TEST_DIR, 'backups'), { recursive: true });
	mkdirSync(path.join(TEST_DIR, 'uploads'), { recursive: true });
	process.env.DATABASE_PATH = path.join(TEST_DIR, 'verif.db');
	process.env.DATA_DIR = TEST_DIR;
	process.env.SESSION_SECRET ||= randomBytes(32).toString('hex');

	const bk = await import('../../src/services/backups.js');
	const bv = await import('../../src/services/backup-verification.js');
	createBackup = bk.createBackup;
	verifyBackupIntegrity = bv.verifyBackupIntegrity;
	runBackupTestRestore = bv.runBackupTestRestore;
	computeReadinessScore = bv.computeReadinessScore;
	pickWeeklyTestRestoreCandidate = bv.pickWeeklyTestRestoreCandidate;
	getRecoveryReadiness = bv.getRecoveryReadiness;
	listBackupVerifications = bv.listBackupVerifications;
});

describe('computeReadinessScore', () => {
	const now = new Date('2026-05-06T12:00:00Z').getTime();
	const fmt = (ms: number) => new Date(now - ms).toISOString().replace('T', ' ').slice(0, 19);

	it('full score when all signals are fresh', () => {
		const r = computeReadinessScore({
			lastSuccessfulBackupAt: fmt(30 * 60_000),
			lastIntegrityAt: fmt(30 * 60_000),
			lastTestRestoreAt: fmt(6 * 86400_000)
		}, now);
		expect(r.score).toBe(100);
		expect(r.riskFactors).toEqual([]);
	});

	it('rescales partial credit against the 80-point local budget', () => {
		const r = computeReadinessScore({
			lastSuccessfulBackupAt: fmt(30 * 60_000),
			lastIntegrityAt: fmt(30 * 60_000),
			lastTestRestoreAt: fmt(8 * 86400_000)
		}, now);
		// 30 + 25 + 12 = 67 of 80 → 84
		expect(r.score).toBe(84);
		expect(r.riskFactors).toEqual(['Last test-restore is older than a week']);
	});

	it('reports specific risk factors when signals are stale', () => {
		const r = computeReadinessScore({
			lastSuccessfulBackupAt: fmt(8 * 86400_000),
			lastIntegrityAt: null,
			lastTestRestoreAt: fmt(60 * 86400_000)
		}, now);
		expect(r.score).toBeLessThan(40);
		expect(r.riskFactors).toContain('No successful backup in the last 7 days');
		expect(r.riskFactors).toContain('Latest backup has not passed an integrity check');
		expect(r.riskFactors).toContain('No successful test-restore in the last 30 days');
	});

	it('zero on no signals', () => {
		const r = computeReadinessScore({
			lastSuccessfulBackupAt: null,
			lastIntegrityAt: null,
			lastTestRestoreAt: null
		}, now);
		expect(r.score).toBe(0);
		expect(r.riskFactors.length).toBeGreaterThan(0);
	});
});

describe('pickWeeklyTestRestoreCandidate', () => {
	it('returns null on empty', () => {
		expect(pickWeeklyTestRestoreCandidate([])).toBe(null);
	});

	it('picks deterministically by week-bucket', () => {
		const files = ['backup-2026-05-01-030000.zip', 'backup-2026-05-02-030000.zip', 'backup-2026-05-03-030000.zip'];
		const week1 = new Date('2026-05-04T00:00:00Z').getTime();
		const week2 = new Date('2026-05-11T00:00:00Z').getTime();
		const a = pickWeeklyTestRestoreCandidate(files, week1);
		const b = pickWeeklyTestRestoreCandidate(files, week2);
		// Same input list, different week: rotation must select different files.
		expect(a).not.toBe(b);
		// Stability within a week.
		expect(pickWeeklyTestRestoreCandidate(files, week1 + 60_000)).toBe(a);
	});

	it('rotates across all candidates over time', () => {
		const files = ['a', 'b', 'c'];
		const seen = new Set<string>();
		for (let w = 0; w < 10; w++) {
			seen.add(pickWeeklyTestRestoreCandidate(files, w * 7 * 86400_000)!);
		}
		expect(seen.size).toBe(3);
	});
});

describe('verifyBackupIntegrity (live backup roundtrip)', () => {
	it('passes on a freshly-created plain backup, fails on a tampered file', async () => {
		const info = await createBackup();
		const result = await verifyBackupIntegrity(info.filename);
		expect(result.status).toBe('passed');
		expect(result.type).toBe('integrity');
		expect(result.details.integrityCheck).toBe('ok');
		expect(result.details.tableCount).toBeGreaterThan(0);

		const filePath = path.join(TEST_DIR, 'backups', info.filename);
		const buf = require('node:fs').readFileSync(filePath);
		// Flip a byte well past the ZIP local header so loadAsync still parses
		// but the deflate stream / sqlite content is corrupted.
		const tampered = Buffer.from(buf);
		tampered[Math.floor(tampered.length * 0.6)] ^= 0xff;
		writeFileSync(filePath, tampered);
		const result2 = await verifyBackupIntegrity(info.filename);
		expect(result2.status).toBe('failed');
		expect(result2.details.error).toBeTruthy();

		// Listing returns both
		const list = listBackupVerifications();
		expect(list.length).toBeGreaterThanOrEqual(2);

		// Readiness was recomputed
		const r = getRecoveryReadiness();
		expect(typeof r.score).toBe('number');
	});

	it('rejects path-traversal filenames', async () => {
		await expect(verifyBackupIntegrity('../../../etc/passwd')).rejects.toThrow();
	});
});

describe('runBackupTestRestore', () => {
	it('passes on a fresh backup', async () => {
		const info = await createBackup();
		const result = await runBackupTestRestore(info.filename);
		expect(result.status).toBe('passed');
		expect(result.type).toBe('restore');
	});
});
