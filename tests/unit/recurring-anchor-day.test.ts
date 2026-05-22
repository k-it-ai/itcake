import { describe, it, expect, beforeAll } from 'vitest';
import { mkdirSync, rmSync, existsSync } from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';

/**
 * The recurring-invoice anchor-day fix (audit L1): when a monthly /
 * quarterly / yearly schedule starts on a day that doesn't exist in
 * every month (29, 30, 31), the next run date must be CLAMPED for that
 * month but not permanently lost. Without anchorDay, dayjs chaining
 * drifts: Jan 31 → Feb 28 → Mar 28 → Apr 28 ... and never returns to
 * the 31st. With anchorDay=31, the schedule re-anchors each month.
 */

const TEST_DIR = path.resolve('data-test-recurring-anchor');

let computeNextDate: typeof import('../../src/services/recurring-invoices.js').computeNextDate;

beforeAll(async () => {
	if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
	mkdirSync(TEST_DIR, { recursive: true });
	process.env.DATABASE_PATH = path.join(TEST_DIR, 'recurring.db');
	process.env.DATA_DIR = TEST_DIR;
	process.env.SESSION_SECRET ||= randomBytes(32).toString('hex');

	const m = await import('../../src/services/recurring-invoices.js');
	computeNextDate = m.computeNextDate;
});
describe('recurring computeNextDate — anchorDay drift fix', () => {
	it('preserves anchor day across short-month rollover (Jan 31 series)', () => {
		const anchor = 31;

		const feb = computeNextDate('2026-01-31', 'monthly', null, anchor);
		expect(feb).toBe('2026-02-28');

		const mar = computeNextDate(feb, 'monthly', null, anchor);
		expect(mar).toBe('2026-03-31');

		const apr = computeNextDate(mar, 'monthly', null, anchor);
		expect(apr).toBe('2026-04-30');

		const may = computeNextDate(apr, 'monthly', null, anchor);
		expect(may).toBe('2026-05-31');
	});

	it('handles leap-year February correctly with anchorDay=29', () => {
		const anchor = 29;
		expect(computeNextDate('2024-01-29', 'monthly', null, anchor)).toBe('2024-02-29');
		expect(computeNextDate('2025-01-29', 'monthly', null, anchor)).toBe('2025-02-28');
		expect(computeNextDate('2025-02-28', 'monthly', null, anchor)).toBe('2025-03-29');
	});

	it('quarterly + yearly schedules respect anchorDay too', () => {
		expect(computeNextDate('2026-01-31', 'quarterly', null, 31)).toBe('2026-04-30');
		expect(computeNextDate('2024-02-29', 'yearly', null, 29)).toBe('2025-02-28');
	});

	it('weekly + custom frequencies ignore anchorDay (date arithmetic only)', () => {
		expect(computeNextDate('2026-01-31', 'weekly', null, 31)).toBe('2026-02-07');
		expect(computeNextDate('2026-01-31', 'custom', 30, 31)).toBe('2026-03-02');
	});

	it('without anchorDay, drifts after the first short-month rollover (regression sanity)', () => {
		const feb = computeNextDate('2026-01-31', 'monthly', null);
		expect(feb).toBe('2026-02-28');
		const mar = computeNextDate(feb, 'monthly', null);
		expect(mar).toBe('2026-03-28');
	});
});

describe('recurring skipMissedDates — safety-limit auto-disable', () => {
	it('disables the recurring + writes audit when the catch-up loop hits the 1000-iteration cap', async () => {
		const { db } = await import('../../src/lib/server/db.js');
		const { processDueRecurringInvoices } = await import('../../src/services/recurring-invoices.js');

		const clientId = 'rec-safety-client';
		db.prepare('DELETE FROM documents WHERE id = ?').run(clientId);
		db.prepare("INSERT INTO documents (id, type, data) VALUES (?, 'client', ?)").run(
			clientId,
			JSON.stringify({ id: clientId, name: 'Safety Client', email: '', address: '', vatId: '', currency: 'EUR', language: 'en' })
		);

		const invoiceId = 'rec-safety-inv';
		db.prepare('DELETE FROM documents WHERE id = ?').run(invoiceId);
		const invoiceData = {
			id: invoiceId, documentId: 'INV-SAFETY', invoiceType: 'invoice', linkedInvoiceId: null,
			clientId, status: 'draft', pricingMode: 'net', currency: 'EUR', language: 'en',
			issueDate: '2020-01-01', dueDate: '2020-01-31', paidDate: null,
			items: [], discounts: [], notes: '', footerText: '', templateId: 'tpl-default',
			templateOptions: {}, kleinunternehmer: false, seller: {}, buyer: {}, totals: {},
			sentAt: null, sentTo: null, createdAt: '2020-01-01T00:00:00Z', updatedAt: '2020-01-01T00:00:00Z',
			recurring: {
				enabled: true, frequency: 'custom', customIntervalDays: 1, nextRunDate: '2020-01-01',
				endDate: null, anchorDay: 1, generatedInvoiceIds: [], lastRunDate: null
			}
		};
		db.prepare("INSERT INTO documents (id, type, data) VALUES (?, 'invoice', ?)").run(invoiceId, JSON.stringify(invoiceData));

		db.prepare("DELETE FROM changes WHERE entity_id = ?").run(invoiceId);

		processDueRecurringInvoices('system');

		const row = db.prepare("SELECT data FROM documents WHERE id = ?").get(invoiceId) as { data: string };
		const updated = JSON.parse(row.data) as typeof invoiceData;
		expect(updated.recurring.enabled).toBe(false);

		const audit = db.prepare(
			"SELECT diff FROM changes WHERE entity_id = ? AND action = 'update' ORDER BY created_at DESC, rowid DESC LIMIT 1"
		).get(invoiceId) as { diff: string };
		const parsed = JSON.parse(audit.diff) as Record<string, { old: unknown; new: unknown }>;
		expect(parsed['recurring.enabled']?.new).toBe(false);
		expect(parsed['recurring.disabledReason']?.new).toBe('safety_limit_reached');
	});
});

describe('remote-sessions prune — clears consumed rows after retention', () => {
	it('deletes ended-and-old + consumed-but-never-ended sessions in addition to unconsumed-expired', async () => {
		const { db } = await import('../../src/lib/server/db.js');
		const { pruneExpiredRemoteSessions } = await import('../../src/services/remote-sessions.js');

		db.exec(`
			CREATE TABLE IF NOT EXISTS agents (
				id TEXT PRIMARY KEY, name TEXT, hostname TEXT, os TEXT, arch TEXT,
				token_hash TEXT, data TEXT NOT NULL DEFAULT '{}'
			);
		`);

		const agentId = 'rem-prune-agent';
		db.prepare('DELETE FROM agents WHERE id = ?').run(agentId);
		db.prepare('INSERT INTO agents (id, name, hostname, os, arch, token_hash, data) VALUES (?, ?, ?, ?, ?, ?, ?)')
			.run(agentId, 'p', 'p', 'linux', 'amd64', 'h', '{}');

		const userId = 'rem-prune-user';
		db.prepare('DELETE FROM users WHERE id = ?').run(userId);
		db.prepare("INSERT INTO users (id, email, name, password_hash) VALUES (?, ?, ?, '')").run(userId, 'p@p', 'p');

		db.prepare("DELETE FROM remote_sessions WHERE agent_id = ?").run(agentId);

		db.prepare(
			"INSERT INTO remote_sessions (id, agent_id, user_id, token_hash, protocol, expires_at, consumed_at, ended_at, client_ip, user_agent, created_at) VALUES " +
			"('rem-keep', ?, ?, 't1', 'rdp', datetime('now', '+10 minutes'), datetime('now', '-1 minutes'), NULL, '127.0.0.1', '', datetime('now', '-5 minutes')), " +
			"('rem-unconsumed-expired', ?, ?, 't2', 'rdp', datetime('now', '-2 minutes'), NULL, NULL, '127.0.0.1', '', datetime('now', '-10 minutes')), " +
			"('rem-ended-90d', ?, ?, 't3', 'rdp', datetime('now', '-95 days'), datetime('now', '-95 days'), datetime('now', '-91 days'), '127.0.0.1', '', datetime('now', '-95 days')), " +
			"('rem-consumed-stale', ?, ?, 't4', 'rdp', datetime('now', '-9 days'), datetime('now', '-8 days'), NULL, '127.0.0.1', '', datetime('now', '-10 days'))"
		).run(agentId, userId, agentId, userId, agentId, userId, agentId, userId);

		const before = db.prepare('SELECT COUNT(*) as n FROM remote_sessions WHERE agent_id = ?').get(agentId) as { n: number };
		expect(before.n).toBe(4);

		pruneExpiredRemoteSessions();

		const remaining = (db.prepare("SELECT id FROM remote_sessions WHERE agent_id = ? ORDER BY id").all(agentId) as { id: string }[]).map(r => r.id);
		expect(remaining).toEqual(['rem-keep']);
	});
});
