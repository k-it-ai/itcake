/**
 * Regression: the invoices table marked its headers sortable, but under
 * server-side pagination the DataTable never emitted a sort — clicking a
 * header only toggled an arrow while the rows stayed in the old order.
 * Sorting now reaches the SQL ORDER BY.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { mkdirSync, rmSync, existsSync } from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';

const TEST_DIR = path.resolve('data-test-invoice-sort');

let db: typeof import('../../src/lib/server/db.js').db;
let getInvoicesPaginated: typeof import('../../src/services/invoices.js').getInvoicesPaginated;

beforeAll(async () => {
	if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
	mkdirSync(TEST_DIR, { recursive: true });
	process.env.DATA_DIR = TEST_DIR;
	process.env.DATABASE_PATH = path.join(TEST_DIR, 'invoices.db');
	process.env.SESSION_SECRET ||= randomBytes(32).toString('hex');

	db = (await import('../../src/lib/server/db.js')).db;
	getInvoicesPaginated = (await import('../../src/services/invoices.js')).getInvoicesPaginated;

	const rows = [
		{ id: 'inv-a', documentId: 'INV-003', gross: 300, issueDate: '2026-03-01', created: '2026-03-01 10:00:00' },
		{ id: 'inv-b', documentId: 'INV-001', gross: 900, issueDate: '2026-01-01', created: '2026-01-01 10:00:00' },
		{ id: 'inv-c', documentId: 'INV-002', gross: 100, issueDate: '2026-02-01', created: '2026-02-01 10:00:00' }
	];
	for (const r of rows) {
		db.prepare('INSERT INTO documents (id, type, data, created_at) VALUES (?, ?, ?, ?)').run(
			r.id, 'invoice',
			JSON.stringify({
				id: r.id, status: 'draft', documentId: r.documentId,
				issueDate: r.issueDate, dueDate: r.issueDate,
				buyer: { name: 'Acme' }, items: [], discounts: [], pricingMode: 'net',
				totals: { net: r.gross, tax: 0, gross: r.gross }
			}),
			r.created
		);
	}
});

const ids = (r: { items: { id: string }[] }) => r.items.map(i => i.id);

describe('invoice list server-side sorting', () => {
	it('sorts by documentId ascending', () => {
		expect(ids(getInvoicesPaginated({}, 1, 25, { key: 'documentId', dir: 'asc' }))).toEqual(['inv-b', 'inv-c', 'inv-a']);
	});

	it('sorts by total descending numerically', () => {
		expect(ids(getInvoicesPaginated({}, 1, 25, { key: 'total', dir: 'desc' }))).toEqual(['inv-b', 'inv-a', 'inv-c']);
	});

	it('sorts by issueDate ascending', () => {
		expect(ids(getInvoicesPaginated({}, 1, 25, { key: 'issueDate', dir: 'asc' }))).toEqual(['inv-b', 'inv-c', 'inv-a']);
	});

	it('falls back to the default order for unknown keys', () => {
		const fallback = ids(getInvoicesPaginated({}, 1, 25, { key: 'no_such_column', dir: 'asc' }));
		const def = ids(getInvoicesPaginated({}, 1, 25));
		expect(fallback).toEqual(def);
	});

	it('keeps paging deterministic under a column sort', () => {
		const first = ids(getInvoicesPaginated({}, 1, 2, { key: 'documentId', dir: 'asc' }));
		const second = ids(getInvoicesPaginated({}, 2, 2, { key: 'documentId', dir: 'asc' }));
		expect([...first, ...second]).toEqual(['inv-b', 'inv-c', 'inv-a']);
	});
});
