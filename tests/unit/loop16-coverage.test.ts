/**
 * Loop-16 coverage tests for previously-untested critical paths:
 *   #4  sanitizeRichText — XSS gate on every user-supplied HTML field
 *   #5  consumeRemoteSession CAS — single-use guarantee on popup load
 *   #6  processCommandResult cross-agent guard — command-id collision
 *   #11 SMTP / Telegram audit-log mask
 *   #15 detectStaleAgents staleThresholdMinutes clamp + transitions
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { mkdirSync, rmSync, existsSync } from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';

const TEST_DIR = path.resolve('data-test-loop16');

beforeAll(async () => {
	if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
	mkdirSync(TEST_DIR, { recursive: true });
	process.env.DATABASE_PATH = path.join(TEST_DIR, 'l16.db');
	process.env.DATA_DIR = TEST_DIR;
	process.env.SESSION_SECRET ||= randomBytes(32).toString('hex');
});

describe('sanitizeRichText (#4 — XSS gate)', () => {
	it('strips <script> tags', async () => {
		const { sanitizeRichText } = await import('../../src/lib/server/sanitize.js');
		const out = sanitizeRichText('hello<script>alert(1)</script>world');
		expect(out).not.toContain('<script>');
		expect(out).not.toContain('alert(1)');
	});

	it('strips <iframe> tags', async () => {
		const { sanitizeRichText } = await import('../../src/lib/server/sanitize.js');
		const out = sanitizeRichText('<iframe src="https://evil.example/"></iframe>');
		expect(out).not.toContain('<iframe');
	});

	it('strips on* event handlers from allowed tags', async () => {
		const { sanitizeRichText } = await import('../../src/lib/server/sanitize.js');
		const out = sanitizeRichText('<img src="x" onerror="alert(1)">');
		expect(out).not.toContain('onerror');
		expect(out).not.toContain('alert(1)');
	});

	it('strips javascript: URLs in hrefs', async () => {
		const { sanitizeRichText } = await import('../../src/lib/server/sanitize.js');
		const out = sanitizeRichText('<a href="javascript:alert(1)">click</a>');
		expect(out).not.toMatch(/javascript:/i);
	});

	it('preserves allowed inline formatting', async () => {
		const { sanitizeRichText } = await import('../../src/lib/server/sanitize.js');
		const out = sanitizeRichText('<p><strong>bold</strong> and <em>italic</em></p>');
		expect(out).toContain('<strong>bold</strong>');
		expect(out).toContain('<em>italic</em>');
	});

	it('strips <object> and <embed>', async () => {
		const { sanitizeRichText } = await import('../../src/lib/server/sanitize.js');
		const out = sanitizeRichText('<object data="data:text/html,&lt;script&gt;1&lt;/script&gt;"></object>');
		expect(out).not.toContain('<object');
	});
});

async function seedAgent(id: string): Promise<void> {
	const db = (await import('../../src/lib/server/db.js')).db;
	const { encryptField } = await import('../../src/lib/server/field-crypto.js');
	const hmacSecret = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
	const enc = encryptField(hmacSecret, `agent.hmacSecret:${id}`);
	db.prepare(`INSERT OR IGNORE INTO agents (id, name, hostname, os, arch, enabled, status, token_hash, hmac_secret)
		VALUES (?, ?, ?, 'linux', 'amd64', 1, 'online', 'h-' || ?, ?)`).run(id, id, id, id, enc);
}

describe('consumeRemoteSession CAS (#5 — single-use)', () => {
	function rsInput(agentId: string) {
		return {
			agentId,
			userId: 'u-rs',
			protocol: 'rdp' as const,
			ttlSeconds: 300,
			clientIp: '127.0.0.1',
			userAgent: 'test'
		};
	}

	it('first consume returns the session; second returns null', async () => {
		const db = (await import('../../src/lib/server/db.js')).db;
		const rs = await import('../../src/services/remote-sessions.js');
		db.prepare(`INSERT OR IGNORE INTO users (id, email, password_hash) VALUES ('u-rs', 'u-rs@t', 'h')`).run();
		await seedAgent('a-rs');

		const created = rs.createRemoteSession(rsInput('a-rs'));
		expect(created.token).toMatch(/^[0-9a-f]+$/);

		const a = rs.consumeRemoteSession(created.token);
		expect(a).not.toBeNull();
		expect(a?.agentId).toBe('a-rs');

		// Second consume — token already burned.
		const b = rs.consumeRemoteSession(created.token);
		expect(b).toBeNull();
	});

	it('expired token returns null without consuming', async () => {
		const db = (await import('../../src/lib/server/db.js')).db;
		const rs = await import('../../src/services/remote-sessions.js');
		await seedAgent('a-rs-exp');
		const created = rs.createRemoteSession(rsInput('a-rs-exp'));
		// Force the expiry to the past.
		db.prepare(`UPDATE remote_sessions SET expires_at = datetime('now', '-1 hour') WHERE id = ?`).run(created.sessionId);
		expect(rs.consumeRemoteSession(created.token)).toBeNull();
	});

	it('malformed token returns null safely', async () => {
		const rs = await import('../../src/services/remote-sessions.js');
		expect(rs.consumeRemoteSession('not-a-real-token')).toBeNull();
		expect(rs.consumeRemoteSession('')).toBeNull();
		expect(rs.consumeRemoteSession('!@#$%^&*()')).toBeNull();
	});
});

describe('processCommandResult cross-agent guard (#6)', () => {
	it('result with mismatched agentId does NOT update the row', async () => {
		const db = (await import('../../src/lib/server/db.js')).db;
		await seedAgent('a-victim');
		await seedAgent('a-attacker');
		const cmd = await import('../../src/services/agent-commands.js');

		// Victim has a pending command.
		const dispatched = cmd.dispatchCommand('a-victim', 'system_info_refresh', {}, 'u-rs');
		const cmdId = dispatched.id;

		// Attacker tries to submit a result for victim's commandId.
		// processCommandResult is void-returning; assertion is via DB.
		cmd.processCommandResult(cmdId, 'a-attacker', {
			status: 'completed',
			exitCode: 0,
			stdout: 'I-Pwn3d-You',
			stderr: '',
			startedAt: new Date().toISOString(),
			completedAt: new Date().toISOString()
		});

		// Row in DB must still be `pending` with empty stdout — the
		// `WHERE id = ? AND agent_id = ?` guard rejects the
		// cross-agent submission.
		const row = db.prepare(`SELECT status, stdout FROM agent_commands WHERE id = ?`).get(cmdId) as { status: string; stdout: string };
		expect(row.status).toBe('pending');
		expect(row.stdout ?? '').not.toContain('I-Pwn3d-You');
	});

	it('matching agentId DOES update the row', async () => {
		const db = (await import('../../src/lib/server/db.js')).db;
		const cmd = await import('../../src/services/agent-commands.js');
		const dispatched = cmd.dispatchCommand('a-victim', 'system_info_refresh', {}, 'u-rs');

		cmd.processCommandResult(dispatched.id, 'a-victim', {
			status: 'completed',
			exitCode: 0,
			stdout: 'ok',
			stderr: '',
			startedAt: new Date().toISOString(),
			completedAt: new Date().toISOString()
		});

		const row = db.prepare(`SELECT status FROM agent_commands WHERE id = ?`).get(dispatched.id) as { status: string };
		expect(row.status).toBe('completed');
	});
});

describe('SMTP / Telegram audit-log mask (#11)', () => {
	it('emails.smtp.pass appears as bullets in audit diff', async () => {
		const db = (await import('../../src/lib/server/db.js')).db;
		const settings = await import('../../src/services/settings.js');
		db.prepare(`INSERT OR IGNORE INTO users (id, email, password_hash) VALUES ('u-l16-m', 'm@t', 'h')`).run();

		settings.updateSettingsSection('emails', {
			smtp: { host: 'smtp.example', port: 587, user: 'u', pass: 'my-real-smtp-password', from: 'f@t', fromName: 'F', secure: true, requireTLS: true }
		}, 'u-l16-m');

		const row = db.prepare(
			`SELECT diff FROM changes WHERE entity_type = 'settings' AND entity_id = 'emails' AND user_id = ? ORDER BY rowid DESC LIMIT 1`
		).get('u-l16-m') as { diff: string };
		expect(row.diff).not.toContain('my-real-smtp-password');
		// Mask glyph should be visible (the audit row contains the masked value).
		expect(row.diff).toContain('••••••••');
	});

	it('uptime.telegram.botToken appears as bullets in audit diff', async () => {
		const db = (await import('../../src/lib/server/db.js')).db;
		const settings = await import('../../src/services/settings.js');

		const realToken = '123456789:abcdefghijklmnopqrstuvwxyz0123456789';
		settings.updateSettingsSection('uptime', {
			telegram: { enabled: true, botToken: realToken, chatId: '42' },
			emailAlerts: false,
			alertEmail: ''
		}, 'u-l16-m');

		const row = db.prepare(
			`SELECT diff FROM changes WHERE entity_type = 'settings' AND entity_id = 'uptime' AND user_id = ? ORDER BY rowid DESC LIMIT 1`
		).get('u-l16-m') as { diff: string };
		expect(row.diff).not.toContain(realToken);
		expect(row.diff).toContain('••••••••');
	});
});

describe('detectStaleAgents threshold clamping (#15)', () => {
	it('staleThresholdMinutes is clamped to 1..60 at the call site', async () => {
		const db = (await import('../../src/lib/server/db.js')).db;
		const { setSetting } = await import('../../src/lib/server/db.js');
		const agents = await import('../../src/services/agents.js');

		db.prepare(`INSERT OR IGNORE INTO agents (id, name, hostname, os, arch, enabled, status, token_hash, hmac_secret, last_seen_at)
			VALUES ('a-stale-zero', 'sz', 'sz', 'linux', 'amd64', 1, 'online', 'h-sz', 'enc3:zzz', datetime('now', '-90 minutes'))`).run();

		// Operator sets a nonsensical 0 minutes — clamp should produce 1 min;
		// agent last_seen 90 min ago → stale × 2 = 2 min cutoff → stale.
		setSetting('rmm', { defaultCheckinInterval: 30, staleThresholdMinutes: 0, metricsRetentionHours: 48, commandTimeoutSeconds: 300 });
		agents.detectStaleAgents();
		const row1 = db.prepare(`SELECT status FROM agents WHERE id = ?`).get('a-stale-zero') as { status: string };
		expect(row1.status).toMatch(/stale|offline/);

		// Operator sets 99999 — clamp to 60. Agent at 90 min ago vs 60*2=120
		// min stale cutoff → still online.
		db.prepare(`UPDATE agents SET status = 'online', last_seen_at = datetime('now', '-90 minutes') WHERE id = ?`).run('a-stale-zero');
		setSetting('rmm', { defaultCheckinInterval: 30, staleThresholdMinutes: 99999, metricsRetentionHours: 48, commandTimeoutSeconds: 300 });
		agents.detectStaleAgents();
		const row2 = db.prepare(`SELECT status FROM agents WHERE id = ?`).get('a-stale-zero') as { status: string };
		expect(row2.status).toBe('online');
	});

	it('fresh agent stays online through detectStaleAgents tick', async () => {
		const db = (await import('../../src/lib/server/db.js')).db;
		const { setSetting } = await import('../../src/lib/server/db.js');
		const agents = await import('../../src/services/agents.js');
		setSetting('rmm', { defaultCheckinInterval: 30, staleThresholdMinutes: 2, metricsRetentionHours: 48, commandTimeoutSeconds: 300 });

		db.prepare(`INSERT OR IGNORE INTO agents (id, name, hostname, os, arch, enabled, status, token_hash, hmac_secret, last_seen_at)
			VALUES ('a-fresh', 'f', 'f', 'linux', 'amd64', 1, 'online', 'h-fresh', 'enc3:zzz', datetime('now'))`).run();

		agents.detectStaleAgents();
		const row = db.prepare(`SELECT status FROM agents WHERE id = ?`).get('a-fresh') as { status: string };
		expect(row.status).toBe('online');
	});
});
