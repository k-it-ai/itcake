/**
 * Regression tests for the third-pass security audit findings:
 *
 * 1. `handleError` redaction — exception .message + .stack run through
 *    the secret-stripper before stderr egress.
 * 2. `log.error` / `log.warn` redact the `err` field AND operator-supplied
 *    `fields` object.
 * 3. `task-runs` stores redacted exception messages in DB.
 * 4. Alert cooldown CAS — concurrent claim attempts decide deterministically.
 * 5. Alert action JSON re-validation — backup-restored rule with malformed
 *    actions falls back to the legacy notify path.
 * 6. Credit-note one-shot marker — re-issue after delete is refused.
 * 7. Monitor notification email body strips control chars from name/host.
 * 8. /api/changes, /api/changes/integrity, and /api/backups/verification
 *    require admin.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { mkdirSync, rmSync, existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';

const TEST_DIR = path.resolve('data-test-third-pass');

let stripSecrets: typeof import('../../src/lib/server/ai/compaction.js').stripSecrets;
let redactSensitiveInput: typeof import('../../src/lib/server/ai/compaction.js').redactSensitiveInput;
let log: typeof import('../../src/lib/server/log.js').log;
let recordTaskRun: typeof import('../../src/lib/server/task-runs.js').recordTaskRun;
let db: typeof import('../../src/lib/server/db.js').db;
let alertActionsSchema: typeof import('../../src/lib/validators-rmm.js').alertActionsSchema;

beforeAll(async () => {
	if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
	mkdirSync(TEST_DIR, { recursive: true });
	process.env.DATABASE_PATH = path.join(TEST_DIR, 'third.db');
	process.env.DATA_DIR = TEST_DIR;
	process.env.SESSION_SECRET ||= randomBytes(32).toString('hex');

	const compaction = await import('../../src/lib/server/ai/compaction.js');
	stripSecrets = compaction.stripSecrets;
	redactSensitiveInput = compaction.redactSensitiveInput;
	log = (await import('../../src/lib/server/log.js')).log;
	recordTaskRun = (await import('../../src/lib/server/task-runs.js')).recordTaskRun;
	db = (await import('../../src/lib/server/db.js')).db;
	alertActionsSchema = (await import('../../src/lib/validators-rmm.js')).alertActionsSchema;
});

describe('stripSecrets is exported and usable', () => {
	it('strips an Anthropic key inline', () => {
		const out = stripSecrets('hi sk-ant-abcdefghijklmnopqrstuvwxyz123 there');
		expect(out).toContain('[REDACTED:anthropic-api-key]');
	});

	it('strips an enc3: ciphertext (≥30 base64 chars)', () => {
		const out = stripSecrets('foo enc3:AAABBBcccddd1234567890abcdef0123456789+/= bar');
		expect(out).toContain('[REDACTED:itcake-encrypted-blob]');
	});
});

describe('handleError source pins the redaction wiring', () => {
	it('handleError stripSecrets the exception message + stack before console.error', () => {
		const src = readFileSync(path.resolve('src/hooks.server.ts'), 'utf-8');
		// The fixed handler must:
		// 1. Import stripSecrets.
		// 2. Call stripSecrets on msg + stack BEFORE console.error.
		// 3. NOT pass the raw `error` object directly to console.error.
		const handlerStart = src.indexOf('export const handleError:');
		expect(handlerStart).toBeGreaterThan(0);
		const handlerSlice = src.slice(handlerStart, handlerStart + 2000);
		expect(handlerSlice).toMatch(/stripSecrets\s*\(\s*msg\s*\)/);
		expect(handlerSlice).toMatch(/console\.error\([^)]*msg/);
		// Anti-regression: the previous form was `console.error('...', error)`.
		expect(handlerSlice).not.toMatch(/console\.error\([^)]*,\s*error\s*\)/);
	});
});

describe('log.error redacts `err` and fields', () => {
	function captureStderr(fn: () => void): string {
		const orig = process.stderr.write.bind(process.stderr);
		let buf = '';
		process.stderr.write = ((chunk: unknown): boolean => {
			buf += typeof chunk === 'string' ? chunk : String(chunk);
			return true;
		}) as typeof process.stderr.write;
		try { fn(); } finally { process.stderr.write = orig; }
		return buf;
	}

	it('strips an Anthropic key from err.message', () => {
		const out = captureStderr(() => {
			log.error('boom', new Error('failed: sk-ant-abcdefghijklmnopqrstuvwxyz123abc'));
		});
		expect(out).toContain('[REDACTED:anthropic-api-key]');
		expect(out).not.toContain('sk-ant-abcdef');
	});

	it('redacts a sensitive key name in fields', () => {
		const out = captureStderr(() => {
			log.error('boom', new Error('plain'), { apiKey: 'arbitrary-plaintext-key' });
		});
		expect(out).toMatch(/REDACTED:sensitive-key:apiKey/);
		expect(out).not.toContain('arbitrary-plaintext-key');
	});

	it('strips an enc3 blob from err.message', () => {
		const out = captureStderr(() => {
			log.error('decrypt failed', new Error('verify: enc3:AAABBBcccddd1234567890abcdef0123456789+/='));
		});
		expect(out).toContain('[REDACTED:itcake-encrypted-blob]');
	});

	it('does not crash on a cyclic fields object (graceful fallback)', () => {
		const cyclic: Record<string, unknown> = { name: 'ok' };
		cyclic.self = cyclic;
		expect(() => log.error('cyclic', new Error('x'), cyclic)).not.toThrow();
	});
});

describe('task-runs.ts strips secrets from stored error column', () => {
	it('an exception carrying an enc3 blob lands redacted in task_runs.error', async () => {
		await expect(recordTaskRun('test_err', async () => {
			throw new Error('mid-rotation failure for enc3:AAABBBcccddd1234567890abcdef0123456789+/=');
		})).rejects.toThrow();
		const row = db.prepare(
			"SELECT error FROM task_runs WHERE kind = 'test_err' ORDER BY id DESC LIMIT 1"
		).get() as { error: string } | undefined;
		expect(row?.error).toBeTruthy();
		expect(row!.error).toContain('[REDACTED:itcake-encrypted-blob]');
		expect(row!.error).not.toContain('enc3:AAABBB');
	});
});

describe('alertActionsSchema is exported + re-validates JSON', () => {
	it('accepts a valid `shell` action', () => {
		const ok = alertActionsSchema.safeParse([
			{ type: 'shell', agentId: 'a-1', command: 'echo ok', timeoutSeconds: 60 }
		]);
		expect(ok.success).toBe(true);
	});

	it('rejects an unknown action type (smuggled via backup restore)', () => {
		const bad = alertActionsSchema.safeParse([
			{ type: 'filesystem_cleanup', agentId: 'a-1', category: 'caches', paths: ['/'] }
		]);
		expect(bad.success).toBe(false);
	});

	it('rejects a malformed action shape', () => {
		const bad = alertActionsSchema.safeParse([{ type: 'shell' }]);
		expect(bad.success).toBe(false);
	});
});

describe('credit-note one-shot marker source-pin', () => {
	it('Invoice type carries `creditNoteIssuedAt` field', () => {
		const src = readFileSync(path.resolve('src/lib/types.ts'), 'utf-8');
		expect(src).toMatch(/creditNoteIssuedAt\?\s*:\s*string\s*\|\s*null/);
	});

	it('createCreditNote checks source.creditNoteIssuedAt + sets it on success', () => {
		const src = readFileSync(path.resolve('src/services/invoices.ts'), 'utf-8');
		// The new gate must be present BEFORE the legacy live-row check.
		expect(src).toMatch(/source\.creditNoteIssuedAt[\s\S]*throw new ServiceError\('error\.creditNoteAlreadyExists'\)[\s\S]*existingCount/);
		// The marker must be set after creditNote creation succeeds.
		expect(src).toMatch(/creditNoteIssuedAt:\s*new Date\(\)\.toISOString\(\)/);
	});
});

describe('alert cooldown CAS', () => {
	it('alerts.ts uses a CAS-style UPDATE with the cooldown predicate', () => {
		const src = readFileSync(path.resolve('src/services/alerts.ts'), 'utf-8');
		expect(src).toMatch(/UPDATE alert_rules[\s\S]*last_fired_at IS NULL OR last_fired_at <= datetime/);
		// And the matcher checks claim.changes !== 1 to skip on lost race.
		expect(src).toMatch(/claim\.changes\s*!==\s*1/);
	});

	it('runAlertActions switch has a `default` case', () => {
		const src = readFileSync(path.resolve('src/services/alerts.ts'), 'utf-8');
		// `default:` inside the switch — explicit fail-closed branch.
		expect(src).toMatch(/case 'wait'[\s\S]*default:\s*\{[\s\S]*unknown alert action type/);
	});
});

describe('monitor-notifications strips control chars from monitor name', () => {
	it('email body interpolates sanitizeHeader-wrapped name + host', () => {
		const src = readFileSync(path.resolve('src/services/monitor-notifications.ts'), 'utf-8');
		expect(src).toMatch(/safeName\s*=\s*sanitizeHeader\(monitor\.name\)/);
		expect(src).toMatch(/safeIdent\s*=\s*sanitizeHeader\(identifier/);
		// The body must use the safe-prefixed values, not the raw ones.
		expect(src).toMatch(/emailDown[\s\S]*?name:\s*safeName/);
	});
});

describe('audit-log endpoints require admin (multi-user prep)', () => {
	it('/api/changes uses requireAdmin', () => {
		const src = readFileSync(path.resolve('src/routes/api/changes/+server.ts'), 'utf-8');
		expect(src).toMatch(/import\s*\{\s*requireAdmin\s*\}/);
		expect(src).toMatch(/requireAdmin\(locals\)/);
		expect(src).not.toMatch(/requireUser\(locals\)/);
	});

	it('/api/changes/integrity uses requireAdmin', () => {
		const src = readFileSync(path.resolve('src/routes/api/changes/integrity/+server.ts'), 'utf-8');
		expect(src).toMatch(/import\s*\{\s*requireAdmin\s*\}/);
		expect(src).toMatch(/requireAdmin\(locals\)/);
	});

	it('/api/backups/verification gates GET and POST actions on admin', () => {
		const src = readFileSync(path.resolve('src/routes/api/backups/verification/+server.ts'), 'utf-8');
		expect(src).toMatch(/import\s*\{[^}]*requireAdmin[^}]*\}/);
		expect(src).not.toMatch(/requireUser\(locals\)/);
		// One gate in GET, one before dispatching POST actions.
		expect(src.match(/requireAdmin\(locals\)/g)?.length).toBe(2);
	});
});

describe('sanitize-html explicit scheme restrictions', () => {
	it('sanitize.ts pins allowedSchemes and disallows protocol-relative URLs', () => {
		const src = readFileSync(path.resolve('src/lib/server/sanitize.ts'), 'utf-8');
		expect(src).toMatch(/allowedSchemes:\s*\[\s*'http',\s*'https',\s*'mailto'\s*\]/);
		expect(src).toMatch(/allowProtocolRelative:\s*false/);
	});
});

describe('processCheckin is wrapped in db.transaction', () => {
	it('agents.ts processCheckin is a transactional export', () => {
		const src = readFileSync(path.resolve('src/services/agents.ts'), 'utf-8');
		expect(src).toMatch(/export const processCheckin\s*=\s*db\.transaction/);
		// And the recordChange call lives AFTER stmtUpdateAgentCheckin, not before.
		const fnStart = src.indexOf('export const processCheckin');
		const fnSlice = src.slice(fnStart, fnStart + 3000);
		const updateIdx = fnSlice.indexOf('stmtUpdateAgentCheckin.run');
		const auditIdx = fnSlice.indexOf("recordChange('agent'");
		expect(updateIdx).toBeGreaterThan(0);
		expect(auditIdx).toBeGreaterThan(updateIdx);
	});
});
