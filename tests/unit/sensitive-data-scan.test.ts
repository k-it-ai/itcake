import { describe, it, expect, beforeAll } from 'vitest';
import { mkdirSync, rmSync, existsSync } from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';

const TEST_DIR = path.resolve('data-test-sensitive-data-scan');

let validateScanScope: typeof import('../../src/services/sensitive-data.js').validateScanScope;
let processSensitiveScanResult: typeof import('../../src/services/sensitive-data.js').processSensitiveScanResult;
let listFindingsByCategory: typeof import('../../src/services/agent-findings.js').listFindingsByCategory;
let db: typeof import('../../src/lib/server/db.js').db;

beforeAll(async () => {
	if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
	mkdirSync(TEST_DIR, { recursive: true });
	mkdirSync(path.join(TEST_DIR, 'backups'), { recursive: true });
	mkdirSync(path.join(TEST_DIR, 'uploads'), { recursive: true });
	process.env.DATABASE_PATH = path.join(TEST_DIR, 'sensitive.db');
	process.env.DATA_DIR = TEST_DIR;
	process.env.SESSION_SECRET ||= randomBytes(32).toString('hex');

	const mod = await import('../../src/services/sensitive-data.js');
	const fmod = await import('../../src/services/agent-findings.js');
	const dbMod = await import('../../src/lib/server/db.js');
	validateScanScope = mod.validateScanScope;
	processSensitiveScanResult = mod.processSensitiveScanResult;
	listFindingsByCategory = fmod.listFindingsByCategory;
	db = dbMod.db;

	db.prepare(`INSERT INTO agents (id, name, hostname, os, arch, token_hash) VALUES ('s-1', 's-1', 's-1', 'linux', 'amd64', 'tk-s-1')`).run();
});

describe('validateScanScope', () => {
	it('accepts a minimal valid scope with defaults applied', () => {
		const s = validateScanScope({ paths: ['/home/user/Documents'] });
		expect(s.paths).toEqual(['/home/user/Documents']);
		expect(s.maxFileSizeBytes).toBe(5_242_880);
		expect(s.timeoutSeconds).toBe(120);
		expect(s.workers).toBe(4);
		expect(s.suppressPaths).toEqual([]);
	});

	it('rejects empty paths array', () => {
		expect(() => validateScanScope({ paths: [] })).toThrow();
	});

	it('rejects missing paths', () => {
		expect(() => validateScanScope({})).toThrow();
	});

	it('rejects oversized maxFileSizeBytes', () => {
		expect(() => validateScanScope({ paths: ['/x'], maxFileSizeBytes: 200_000_000 })).toThrow();
	});

	it('rejects undersized maxFileSizeBytes', () => {
		expect(() => validateScanScope({ paths: ['/x'], maxFileSizeBytes: 100 })).toThrow();
	});

	it('rejects timeout out of range', () => {
		expect(() => validateScanScope({ paths: ['/x'], timeoutSeconds: 4 })).toThrow();
		expect(() => validateScanScope({ paths: ['/x'], timeoutSeconds: 5000 })).toThrow();
	});

	it('rejects workers out of range', () => {
		expect(() => validateScanScope({ paths: ['/x'], workers: 0 })).toThrow();
		expect(() => validateScanScope({ paths: ['/x'], workers: 100 })).toThrow();
	});

	it('rejects oversized arrays', () => {
		const tooManyPaths = Array.from({ length: 65 }, (_, i) => `/p${i}`);
		expect(() => validateScanScope({ paths: tooManyPaths })).toThrow();
	});

	it('accepts custom suppressPatternIds', () => {
		const s = validateScanScope({ paths: ['/x'], suppressPatternIds: ['pii_email'] });
		expect(s.suppressPatternIds).toEqual(['pii_email']);
	});
});

describe('processSensitiveScanResult', () => {
	it('records findings with proper fingerprints + severity', () => {
		const res = processSensitiveScanResult('cmd-sec-1', 's-1', {
			findings: [
				{ path: '/etc/secret.env', line: 3, patternId: 'credential_aws_access_key', severity: 'critical', sample: 'AKIAIOSFODNN7EXAMPLE' }
			],
			summary: { filesScanned: 1, bytesScanned: 100, durationMs: 5 }
		});
		expect(res.findingsRecorded).toBe(1);
		const findings = listFindingsByCategory('s-1', 'sensitive_data', 100);
		expect(findings.length).toBeGreaterThan(0);
		const f = findings[0];
		expect(f.severity).toBe('critical');
		expect((f.evidence as { patternId: string }).patternId).toBe('credential_aws_access_key');
	});

	it('redacts secret-assignment samples and bounds the result', () => {
		const longSample = `password = "${'a'.repeat(200)}"`;
		processSensitiveScanResult('cmd-sec-2', 's-1', {
			findings: [
				{ path: '/etc/big.env', line: 1, patternId: 'credential_secret_assignment', severity: 'high', sample: longSample }
			]
		});
		const findings = listFindingsByCategory('s-1', 'sensitive_data', 100);
		const f = findings.find(x => (x.evidence as { path: string }).path === '/etc/big.env');
		expect(f).toBeTruthy();
		const stored = (f!.evidence as { sample: string }).sample;
		expect(stored).toBe('password = [REDACTED]');
		expect(stored).not.toContain('aaaa');
	});

	it('redacts long raw samples even with unknown pattern (truncates to 64)', () => {
		const longSample = 'b'.repeat(200);
		processSensitiveScanResult('cmd-sec-2b', 's-1', {
			findings: [
				{ path: '/etc/unknown.env', line: 1, patternId: 'phi_medical_reference', severity: 'medium', sample: longSample }
			]
		});
		const findings = listFindingsByCategory('s-1', 'sensitive_data', 100);
		const f = findings.find(x => (x.evidence as { path: string }).path === '/etc/unknown.env');
		expect(f).toBeTruthy();
		expect((f!.evidence as { sample: string }).sample.length).toBe(64);
	});

	it('repeated findings dedup via fingerprint', () => {
		processSensitiveScanResult('cmd-sec-3', 's-1', {
			findings: [
				{ path: '/etc/dup.env', line: 5, patternId: 'pii_email', severity: 'low', sample: 'a@b.co' }
			]
		});
		const before = listFindingsByCategory('s-1', 'sensitive_data', 200).length;
		processSensitiveScanResult('cmd-sec-3b', 's-1', {
			findings: [
				{ path: '/etc/dup.env', line: 5, patternId: 'pii_email', severity: 'low', sample: 'a@b.co' }
			]
		});
		const after = listFindingsByCategory('s-1', 'sensitive_data', 200).length;
		expect(after).toBe(before);
	});

	it('different lines produce different fingerprints', () => {
		processSensitiveScanResult('cmd-sec-4', 's-1', {
			findings: [
				{ path: '/etc/multi.env', line: 1, patternId: 'pii_email', severity: 'low', sample: 'x@y.co' },
				{ path: '/etc/multi.env', line: 9, patternId: 'pii_email', severity: 'low', sample: 'x@y.co' }
			]
		});
		const findings = listFindingsByCategory('s-1', 'sensitive_data', 200).filter(f => (f.evidence as { path: string }).path === '/etc/multi.env');
		expect(findings.length).toBe(2);
	});

	it('rejects malformed payload silently', () => {
		const r = processSensitiveScanResult('cmd-sec-5', 's-1', { findings: 'not-an-array' } as Record<string, unknown>);
		expect(r.findingsRecorded).toBe(0);
	});
});
