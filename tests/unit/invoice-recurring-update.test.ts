/**
 * Regression: `recurring` was missing from INVOICE_MUTABLE_FIELDS, so
 * `updateInvoice()` silently dropped every schedule change — the primary way
 * an operator edits a recurring invoice's next run.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { mkdirSync, rmSync, existsSync } from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import type { RecurringConfig } from '../../src/lib/types.js';

const TEST_DIR = path.resolve('data-test-invoice-recurring');

let db: typeof import('../../src/lib/server/db.js').db;
let updateInvoice: typeof import('../../src/services/invoices.js').updateInvoice;

beforeAll(async () => {
	if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
	mkdirSync(TEST_DIR, { recursive: true });
	process.env.DATA_DIR = TEST_DIR;
	process.env.DATABASE_PATH = path.join(TEST_DIR, 'recurring.db');
	process.env.SESSION_SECRET ||= randomBytes(32).toString('hex');

	db = (await import('../../src/lib/server/db.js')).db;
	updateInvoice = (await import('../../src/services/invoices.js')).updateInvoice;

	db.prepare('INSERT INTO documents (id, type, data) VALUES (?, ?, ?)').run('inv-1', 'invoice', JSON.stringify({
		id: 'inv-1',
		status: 'draft',
		items: [],
		discounts: [],
		pricingMode: 'net',
		totals: { net: 0, tax: 0, gross: 0 },
		recurring: null,
		issueDate: '2026-01-01',
		dueDate: '2026-01-31'
	}));
});

function recurring(overrides: Partial<RecurringConfig> = {}): RecurringConfig {
	return {
		enabled: true,
		frequency: 'monthly',
		customIntervalDays: null,
		nextRunDate: '2026-11-15',
		endDate: null,
		lastRunDate: null,
		generatedInvoiceIds: [],
		...overrides
	};
}

describe('updateInvoice — recurring schedules', () => {
	it('persists a recurring config and normalises anchorDay', () => {
		const updated = updateInvoice('inv-1', { recurring: recurring() }, 'u-1');
		expect(updated).not.toBeNull();
		expect(updated?.recurring?.nextRunDate).toBe('2026-11-15');
		expect(updated?.recurring?.anchorDay).toBe(15);

		const row = db.prepare("SELECT data FROM documents WHERE id = 'inv-1'").get() as { data: string };
		const stored = JSON.parse(row.data);
		expect(stored.recurring.frequency).toBe('monthly');
		expect(stored.recurring.anchorDay).toBe(15);
	});

	it('keeps an explicitly supplied anchorDay', () => {
		const updated = updateInvoice('inv-1', { recurring: recurring({ nextRunDate: '2026-12-01', anchorDay: 31 }) }, 'u-1');
		expect(updated?.recurring?.anchorDay).toBe(31);
	});

	it('allows clearing the schedule', () => {
		const updated = updateInvoice('inv-1', { recurring: null as unknown as RecurringConfig }, 'u-1');
		expect(updated?.recurring).toBeNull();
		const row = db.prepare("SELECT data FROM documents WHERE id = 'inv-1'").get() as { data: string };
		expect(JSON.parse(row.data).recurring).toBeNull();
	});
});
