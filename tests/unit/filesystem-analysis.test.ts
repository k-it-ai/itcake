import { describe, it, expect, beforeAll } from 'vitest';
import { mkdirSync, rmSync, existsSync } from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';

const TEST_DIR = path.resolve('data-test-filesystem-analysis');

let validateFilesystemScope: typeof import('../../src/services/filesystem.js').validateFilesystemScope;
let processFilesystemAnalysisResult: typeof import('../../src/services/filesystem.js').processFilesystemAnalysisResult;
let processFilesystemCleanupResult: typeof import('../../src/services/filesystem.js').processFilesystemCleanupResult;
let filesystemCleanupSchema: typeof import('../../src/services/filesystem.js').filesystemCleanupSchema;
let listFindingsByCategory: typeof import('../../src/services/agent-findings.js').listFindingsByCategory;
let getLatestCollectorResult: typeof import('../../src/services/agent-collector-results.js').getLatestCollectorResult;
let validateCommandPayload: typeof import('../../src/lib/validators-rmm.js').validateCommandPayload;
let db: typeof import('../../src/lib/server/db.js').db;

beforeAll(async () => {
	if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
	mkdirSync(TEST_DIR, { recursive: true });
	mkdirSync(path.join(TEST_DIR, 'backups'), { recursive: true });
	mkdirSync(path.join(TEST_DIR, 'uploads'), { recursive: true });
	process.env.DATABASE_PATH = path.join(TEST_DIR, 'fs.db');
	process.env.DATA_DIR = TEST_DIR;
	process.env.SESSION_SECRET ||= randomBytes(32).toString('hex');

	const mod = await import('../../src/services/filesystem.js');
	const fmod = await import('../../src/services/agent-findings.js');
	const cmod = await import('../../src/services/agent-collector-results.js');
	const vmod = await import('../../src/lib/validators-rmm.js');
	const dbMod = await import('../../src/lib/server/db.js');
	validateFilesystemScope = mod.validateFilesystemScope;
	processFilesystemAnalysisResult = mod.processFilesystemAnalysisResult;
	processFilesystemCleanupResult = mod.processFilesystemCleanupResult;
	filesystemCleanupSchema = mod.filesystemCleanupSchema;
	listFindingsByCategory = fmod.listFindingsByCategory;
	getLatestCollectorResult = cmod.getLatestCollectorResult;
	validateCommandPayload = vmod.validateCommandPayload;
	db = dbMod.db;

	db.prepare(`INSERT INTO agents (id, name, hostname, os, arch, token_hash) VALUES ('fs-1', 'fs-1', 'fs-1', 'linux', 'amd64', 'tk-fs-1')`).run();
});

describe('validateFilesystemScope', () => {
	it('accepts a minimal valid scope and applies defaults', () => {
		const s = validateFilesystemScope({ paths: ['/var/log', '/tmp'] });
		expect(s.paths).toEqual(['/var/log', '/tmp']);
		expect(s.timeoutSeconds).toBe(600);
		expect(s.workers).toBe(4);
		expect(s.maxFileSizeBytes).toBe(5 * 1024 * 1024 * 1024);
		expect(s.skipPatterns).toEqual([]);
	});

	it('rejects empty paths array', () => {
		expect(() => validateFilesystemScope({ paths: [] })).toThrow();
	});

	it('rejects missing paths', () => {
		expect(() => validateFilesystemScope({})).toThrow();
	});

	it('rejects negative or out-of-range timeout', () => {
		expect(() => validateFilesystemScope({ paths: ['/x'], timeoutSeconds: -1 })).toThrow();
		expect(() => validateFilesystemScope({ paths: ['/x'], timeoutSeconds: 4 })).toThrow();
		expect(() => validateFilesystemScope({ paths: ['/x'], timeoutSeconds: 99999 })).toThrow();
	});

	it('rejects oversized maxFileSizeBytes', () => {
		expect(() => validateFilesystemScope({ paths: ['/x'], maxFileSizeBytes: 200 * 1024 * 1024 * 1024 })).toThrow();
	});

	it('rejects out-of-range workers', () => {
		expect(() => validateFilesystemScope({ paths: ['/x'], workers: 0 })).toThrow();
		expect(() => validateFilesystemScope({ paths: ['/x'], workers: 64 })).toThrow();
	});

	it('rejects oversized paths array', () => {
		const tooMany = Array.from({ length: 65 }, (_, i) => `/p${i}`);
		expect(() => validateFilesystemScope({ paths: tooMany })).toThrow();
	});
});

describe('filesystemCleanupSchema', () => {
	it('accepts absolute Linux paths', () => {
		const r = filesystemCleanupSchema.safeParse({ category: 'temp_files', paths: ['/tmp/a', '/tmp/b'] });
		expect(r.success).toBe(true);
	});

	it('accepts absolute Windows paths', () => {
		const r = filesystemCleanupSchema.safeParse({ category: 'temp_files', paths: ['C:\\Windows\\Temp\\x', 'D:/cache/y'] });
		expect(r.success).toBe(true);
	});

	it('rejects relative paths', () => {
		const r = filesystemCleanupSchema.safeParse({ category: 'temp_files', paths: ['tmp/a'] });
		expect(r.success).toBe(false);
	});

	it('rejects unknown category', () => {
		const r = filesystemCleanupSchema.safeParse({ category: 'unrotated_logs', paths: ['/var/log/x'] });
		expect(r.success).toBe(false);
	});

	it('rejects > 1000 paths', () => {
		const tooMany = Array.from({ length: 1001 }, (_, i) => `/tmp/${i}`);
		const r = filesystemCleanupSchema.safeParse({ category: 'temp_files', paths: tooMany });
		expect(r.success).toBe(false);
	});
});

describe('processFilesystemAnalysisResult', () => {
	it('records the result and emits findings only above threshold', () => {
		const big = 6 * 1024 * 1024 * 1024;
		const small = 1 * 1024 * 1024 * 1024;
		const out = processFilesystemAnalysisResult('cmd-fs-a', 'fs-1', {
			scannedAt: new Date().toISOString(),
			durationSeconds: 5,
			filesScanned: 1234,
			bytesScanned: big + small,
			directoriesScanned: 50,
			categories: [
				{ id: 'temp_files', totalBytes: big, fileCount: 100, samples: [] },
				{ id: 'browser_cache', totalBytes: small, fileCount: 30, samples: [] }
			],
			topFiles: [],
			topDirectories: [],
			truncated: false,
			errors: []
		});
		expect(out.categoriesRecorded).toBe(2);
		expect(out.findingsEmitted).toBe(1);
		const findings = listFindingsByCategory('fs-1', 'filesystem', 100);
		expect(findings.length).toBeGreaterThan(0);
		expect(findings.some(f => (f.evidence as { categoryId: string }).categoryId === 'temp_files')).toBe(true);
		expect(findings.some(f => (f.evidence as { categoryId: string }).categoryId === 'browser_cache')).toBe(false);

		const latest = getLatestCollectorResult('fs-1', 'filesystem_analysis');
		expect(latest).not.toBeNull();
		expect((latest!.payload as { categories: unknown[] }).categories.length).toBe(2);
	});

	it('repeated finding for the same category dedups via fingerprint', () => {
		const before = listFindingsByCategory('fs-1', 'filesystem', 200).length;
		processFilesystemAnalysisResult('cmd-fs-b', 'fs-1', {
			categories: [{ id: 'temp_files', totalBytes: 8 * 1024 * 1024 * 1024, fileCount: 200, samples: [] }],
			topFiles: [],
			topDirectories: [],
			errors: []
		});
		const after = listFindingsByCategory('fs-1', 'filesystem', 200).length;
		expect(after).toBe(before);
	});

	it('rejects malformed payload silently', () => {
		const r = processFilesystemAnalysisResult('cmd-fs-c', 'fs-1', { categories: 'not-an-array' } as Record<string, unknown>);
		expect(r.categoriesRecorded).toBe(0);
		expect(r.findingsEmitted).toBe(0);
	});
});

describe('processFilesystemCleanupResult', () => {
	it('records and returns aggregated counts', () => {
		const r = processFilesystemCleanupResult('cmd-fs-d', 'fs-1', {
			deleted: 12, skipped: 3, freedBytes: 65536, errors: ['x: too big']
		});
		expect(r.deleted).toBe(12);
		expect(r.freedBytes).toBe(65536);
	});
});

describe('validateCommandPayload (filesystem types)', () => {
	it('accepts a valid filesystem_analysis payload', () => {
		const r = validateCommandPayload('filesystem_analysis', { scope: { paths: ['/var/log'] } });
		expect(r.ok).toBe(true);
	});

	it('rejects filesystem_analysis with missing scope', () => {
		const r = validateCommandPayload('filesystem_analysis', {});
		expect(r.ok).toBe(false);
	});

	it('rejects filesystem_cleanup with relative path', () => {
		const r = validateCommandPayload('filesystem_cleanup', { category: 'temp_files', paths: ['rel/path'] });
		expect(r.ok).toBe(false);
	});

	it('rejects filesystem_cleanup with bad category', () => {
		const r = validateCommandPayload('filesystem_cleanup', { category: 'unrotated_logs', paths: ['/tmp/x'] });
		expect(r.ok).toBe(false);
	});

	it('accepts filesystem_cleanup with absolute path + valid category', () => {
		const r = validateCommandPayload('filesystem_cleanup', { category: 'temp_files', paths: ['/tmp/x', 'C:\\Temp\\y'] });
		expect(r.ok).toBe(true);
	});

	it('rejects filesystem_cleanup with > 1000 paths', () => {
		const tooMany = Array.from({ length: 1001 }, (_, i) => `/tmp/${i}`);
		const r = validateCommandPayload('filesystem_cleanup', { category: 'temp_files', paths: tooMany });
		expect(r.ok).toBe(false);
	});
});
