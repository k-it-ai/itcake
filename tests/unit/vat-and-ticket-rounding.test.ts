/**
 * Two validation hardening fixes:
 *
 *   1. VAT-ID format check per EU country prefix. Catches the common
 *      operator typo `DE12345` (5 digits instead of 9) at the data
 *      boundary so reverse-charge invoices ship with valid VAT IDs.
 *
 *   2. Ticket `hours` clamped to 2 decimals at schema time so the dashboard
 *      banner ("hours-this-week × hourlyRate") matches the line-item
 *      converted total to the cent. Previously, 0.333h showed $29.97
 *      earned but billed $29.70.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { mkdirSync, rmSync, existsSync } from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';

const TEST_DIR = path.resolve('data-test-vat-ticket');

let createClient: typeof import('../../src/services/clients.js').createClient;
let updateClient: typeof import('../../src/services/clients.js').updateClient;
let ticketSchema: typeof import('../../src/lib/validators.js').ticketSchema;

beforeAll(async () => {
	if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
	mkdirSync(TEST_DIR, { recursive: true });
	process.env.DATABASE_PATH = path.join(TEST_DIR, 'vat.db');
	process.env.DATA_DIR = TEST_DIR;
	process.env.SESSION_SECRET ||= randomBytes(32).toString('hex');

	const c = await import('../../src/services/clients.js');
	createClient = c.createClient;
	updateClient = c.updateClient;
	const v = await import('../../src/lib/validators.js');
	ticketSchema = v.ticketSchema;

	const db = (await import('../../src/lib/server/db.js')).db;
	db.prepare(`INSERT INTO users (id, email, password_hash) VALUES (?, ?, ?)`).run('u', 'u@t', 'h');
});

function baseClient(over: Partial<Parameters<typeof createClient>[0]>): Parameters<typeof createClient>[0] {
	return {
		clientNumber: '',
		name: 'Test',
		email: 'test@example.com',
		phone: '',
		website: '',
		vatNumber: '',
		registrationNumber: '',
		address: { street: '1 St', city: 'Berlin', zip: '10115', state: '', country: 'DE' },
		notes: '',
		contactPerson: '',
		language: 'en',
		currency: 'EUR',
		paymentTermDays: 30,
		...over
	} as Parameters<typeof createClient>[0];
}

describe('VAT-ID per-country format validation', () => {
	it('accepts a valid DE VAT ID at create time', () => {
		const c = createClient(baseClient({ name: 'OK DE', vatNumber: 'DE123456789' }), 'u');
		expect(c.vatNumber).toBe('DE123456789');
	});

	it('rejects a too-short DE VAT ID', () => {
		expect(() => createClient(baseClient({ name: 'Bad DE', vatNumber: 'DE12345' }), 'u'))
			.toThrow(/vatNumberFormat/);
	});

	it('rejects a malformed NL VAT ID (must have B + 2 digits suffix)', () => {
		expect(() => createClient(baseClient({ name: 'Bad NL', vatNumber: 'NL123456789' }), 'u'))
			.toThrow(/vatNumberFormat/);
	});

	it('accepts a valid NL VAT ID', () => {
		const c = createClient(baseClient({ name: 'OK NL', vatNumber: 'NL123456789B01' }), 'u');
		expect(c.vatNumber).toBe('NL123456789B01');
	});

	it('accepts a non-EU prefix verbatim (e.g., US 95-1234567)', () => {
		const c = createClient(baseClient({ name: 'OK US', vatNumber: '95-1234567' }), 'u');
		expect(c.vatNumber).toBe('95-1234567');
	});

	it('accepts an empty VAT number (field is optional)', () => {
		const c = createClient(baseClient({ name: 'No VAT', vatNumber: '' }), 'u');
		expect(c.vatNumber).toBe('');
	});

	it('check fires on updateClient too', () => {
		const c = createClient(baseClient({ name: 'Update target', vatNumber: 'DE123456789' }), 'u');
		expect(() => updateClient(c.id, { vatNumber: 'DE12' }, 'u')).toThrow(/vatNumberFormat/);
	});
});

describe('Ticket hours clamped to 2 decimals at schema time', () => {
	it('rounds 0.333 to 0.33', () => {
		const r = ticketSchema.safeParse({
			title: 't', description: '', clientId: 'c1', date: '2026-05-22', startTime: '09:00',
			hours: 0.333, hourlyRate: 9000, notes: ''
		});
		expect(r.success).toBe(true);
		if (r.success) expect(r.data.hours).toBe(0.33);
	});

	it('rounds 0.337 to 0.34', () => {
		const r = ticketSchema.safeParse({
			title: 't', description: '', clientId: 'c1', date: '2026-05-22', startTime: '09:00',
			hours: 0.337, hourlyRate: 9000, notes: ''
		});
		expect(r.success).toBe(true);
		if (r.success) expect(r.data.hours).toBe(0.34);
	});

	it('preserves exact 2-decimal values', () => {
		const r = ticketSchema.safeParse({
			title: 't', description: '', clientId: 'c1', date: '2026-05-22', startTime: '09:00',
			hours: 2.5, hourlyRate: 9000, notes: ''
		});
		expect(r.success).toBe(true);
		if (r.success) expect(r.data.hours).toBe(2.5);
	});

	it('still enforces the 0.01..24 range', () => {
		expect(ticketSchema.safeParse({
			title: 't', description: '', clientId: 'c1', date: '2026-05-22', startTime: '09:00',
			hours: 0, hourlyRate: 9000, notes: ''
		}).success).toBe(false);
		expect(ticketSchema.safeParse({
			title: 't', description: '', clientId: 'c1', date: '2026-05-22', startTime: '09:00',
			hours: 25, hourlyRate: 9000, notes: ''
		}).success).toBe(false);
	});
});
