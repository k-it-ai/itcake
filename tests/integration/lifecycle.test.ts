import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { existsSync, mkdirSync, rmSync } from 'node:fs';
import path from 'node:path';

const TEST_PORT = 5298;
const BASE = `http://localhost:${TEST_PORT}`;
const TEST_DATA_DIR = path.resolve('data-test-integration');
const TEST_DB = path.join(TEST_DATA_DIR, 'test.db');
const TEST_PROC_DB = path.join(TEST_DATA_DIR, 'test-process.db');
process.env.DATABASE_PATH = TEST_PROC_DB;
process.env.DATA_DIR = TEST_DATA_DIR;
mkdirSync(TEST_DATA_DIR, { recursive: true });
const COOKIE_JAR: Record<string, string> = {};

let serverProcess: ReturnType<typeof import('node:child_process').spawn>;

function extractCookies(res: Response) {
	const setCookie = res.headers.getSetCookie?.() ?? [];
	for (const c of setCookie) {
		const [kv] = c.split(';');
		const [k, v] = kv.split('=');
		if (v) COOKIE_JAR[k] = v;
		else delete COOKIE_JAR[k];
	}
}

function cookieHeader(): string {
	return Object.entries(COOKIE_JAR).map(([k, v]) => `${k}=${v}`).join('; ');
}

async function api(method: string, path: string, body?: unknown): Promise<{ status: number; data: Record<string, unknown> }> {
	const res = await fetch(`${BASE}${path}`, {
		method,
		headers: {
			'Content-Type': 'application/json',
			'Origin': BASE,
			'Cookie': cookieHeader()
		},
		body: body ? JSON.stringify(body) : undefined,
		redirect: 'manual'
	});
	extractCookies(res);
	const text = await res.text();
	let data: Record<string, unknown> = {};
	try { data = JSON.parse(text); } catch { data = { raw: text }; }
	return { status: res.status, data };
}

async function formAction(pagePath: string, action: string, formData: Record<string, string> = {}): Promise<{ status: number; data: Record<string, unknown> }> {
	const body = new URLSearchParams(formData).toString();
	const url = action ? `${BASE}${pagePath}?/${action}` : `${BASE}${pagePath}`;
	const res = await fetch(url, {
		method: 'POST',
		headers: {
			'Content-Type': 'application/x-www-form-urlencoded',
			'Origin': BASE,
			'Cookie': cookieHeader()
		},
		body,
		redirect: 'manual'
	});
	extractCookies(res);

	if (res.status === 303 || res.status === 302) {
		return { status: res.status, data: { redirect: res.headers.get('location') ?? '' } };
	}
	const text = await res.text();
	let data: Record<string, unknown> = {};
	try { data = JSON.parse(text); } catch { data = { raw: text }; }
	return { status: res.status, data };
}

beforeAll(async () => {
	if (existsSync(TEST_DATA_DIR)) rmSync(TEST_DATA_DIR, { recursive: true });
	mkdirSync(TEST_DATA_DIR, { recursive: true });
	mkdirSync(path.join(TEST_DATA_DIR, 'uploads'), { recursive: true });
	mkdirSync(path.join(TEST_DATA_DIR, 'backups'), { recursive: true });

	const { spawn } = await import('node:child_process');
	const { randomBytes } = await import('node:crypto');
	const sessionSecret = process.env.SESSION_SECRET ?? randomBytes(32).toString('hex');
	serverProcess = spawn('node_modules/.bin/vite', ['dev', '--port', String(TEST_PORT)], {
		env: {
			...process.env,
			DATABASE_PATH: TEST_DB,
			DATA_DIR: TEST_DATA_DIR,
			PORT: String(TEST_PORT),
			HOST: '127.0.0.1',
			SESSION_SECRET: sessionSecret
		},
		stdio: 'pipe'
	});

	for (let i = 0; i < 30; i++) {
		try {
			const res = await fetch(`${BASE}/api/health`);
			if (res.ok) break;
		} catch { /* not ready */ }
		await new Promise(r => setTimeout(r, 1000));
	}
}, 60000);

// Reset login rate-limit buckets between tests that exercise many login
// attempts. The buckets are 3/email/15min and 10/IP/15min; honouring them
// in tests would require waiting 15 real minutes between phases. Tests
// directly clear the rate_limits SQLite table.
async function clearRateLimits() {
	const Database = (await import('better-sqlite3')).default;
	const sdb = new Database(TEST_DB);
	try {
		sdb.prepare('DELETE FROM rate_limits').run();
	} finally {
		sdb.close();
	}
}

// Reset the MFA step-up replay cache. Login TOTP completion now inserts the
// code into mfa_step_up_used_codes (90s window); tests that consume a TOTP
// at login and then a TOTP at a step-up surface within the same step would
// otherwise hit the legitimate replay rejection.
async function clearStepUpCache() {
	const Database = (await import('better-sqlite3')).default;
	const sdb = new Database(TEST_DB);
	try {
		sdb.prepare('DELETE FROM mfa_step_up_used_codes').run();
	} finally {
		sdb.close();
	}
}

afterAll(() => {
	serverProcess?.kill();
	if (existsSync(TEST_DATA_DIR)) rmSync(TEST_DATA_DIR, { recursive: true });
});

const today = new Date().toISOString().split('T')[0];
const due = new Date(Date.now() + 30 * 86400000).toISOString().split('T')[0];
const ids: Record<string, string> = {};

describe('lifecycle', () => {

	it('setup → login → auth check', async () => {
		const setupRes = await fetch(`${BASE}/setup`, {
			method: 'POST',
			headers: { 'Origin': BASE, 'Content-Type': 'application/x-www-form-urlencoded' },
			body: 'name=Test+User&email=test%40test.com&password=Testpassword123&companyName=Test+Corp&language=en&currency=EUR',
			redirect: 'manual'
		});
		extractCookies(setupRes);
		// The body must be checked — the HTTP status alone would hide setup failures.
		expect(setupRes.status).toBe(200);
		const setupEnvelope = JSON.parse(await setupRes.clone().text()) as { type: string };
		expect(setupEnvelope.type, 'setup form action must succeed').toBe('redirect');

		const me = await api('GET', '/api/auth/me');
		expect(me.data.email).toBe('test@test.com');

		const reSetup = await fetch(`${BASE}/setup`, { redirect: 'manual' });
		expect(reSetup.status).toBe(302);
	}, 30000);


	it('client CRUD', async () => {
		const client = await api('POST', '/api/clients', {
			name: 'Acme GmbH', email: 'client@test.com',
			address: { street: '1 Test St', city: 'Berlin', zip: '10115', state: '', country: 'DE' },
			phone: '+49 30 12345', website: 'https://acme.de', vatNumber: 'DE123456789',
			contactPerson: 'Max Mustermann', language: 'en', currency: 'EUR', paymentTermDays: 14
		});
		expect(client.status).toBeLessThan(300);
		expect(client.data.clientNumber).toBe('C-001');
		ids.client = client.data.id as string;

		const upd = await api('POST', '/api/clients', { action: 'update', id: ids.client, phone: '+49 30 99999' });
		expect(upd.data.phone).toBe('+49 30 99999');

		const client2 = await api('POST', '/api/clients', { name: 'Beta Corp', email: 'b@test.com', address: { street: '2 Test St', city: 'Munich', zip: '80331', country: 'DE' } });
		expect(client2.data.clientNumber).toBe('C-002');
		ids.client2 = client2.data.id as string;

		const yesterday = new Date(Date.now() - 86400000).toISOString().split('T')[0];
		const futureEnd = new Date(Date.now() + 365 * 86400000).toISOString().split('T')[0];
		const recInv = await api('POST', '/api/invoices', {
			clientId: ids.client, pricingMode: 'net', currency: 'EUR', language: 'en',
			issueDate: yesterday, dueDate: today,
			items: [{ id: 'rec1', name: 'Monthly hosting', description: '', quantity: 1, unit: 'month', unitPrice: 2999, taxRate: 19, items: [] }],
			discounts: [], notes: 'RECURRING_SOURCE', footerText: '', templateId: 'kossov-it', templateOptions: {},
			recurring: {
				enabled: true, frequency: 'monthly', customIntervalDays: null,
				nextRunDate: yesterday, endDate: futureEnd, lastRunDate: null, generatedInvoiceIds: []
			}
		});
		expect(recInv.status).toBeLessThan(300);
		ids.recurringSource = recInv.data.id as string;
	}, 15000);


	it('invoice: create, edit, preview, PDF, status transitions', async () => {
		const invoice = await api('POST', '/api/invoices', {
			clientId: ids.client, pricingMode: 'net', currency: 'EUR', language: 'en',
			issueDate: today, dueDate: due,
			items: [
				{ id: 'i1', name: 'Web Development', description: 'Frontend work', quantity: 10, unit: 'hrs', unitPrice: 9500, taxRate: 19, items: [] },
				{ id: 'i2', name: 'Server Setup', description: '', quantity: 1, unit: 'pc', unitPrice: 29900, taxRate: 19, items: [] }
			],
			discounts: [], notes: 'Test invoice', footerText: '', templateId: 'kossov-it', templateOptions: {}
		});
		expect(invoice.status).toBeLessThan(300);
		const year = new Date().getFullYear();
		expect(invoice.data.documentId).toMatch(new RegExp(`^${year}-\\d{4}$`));
		const totals = invoice.data.totals as Record<string, number>;
		expect(totals.subtotal).toBe(124900);
		expect(totals.total).toBe(148631);
		ids.invoice = invoice.data.id as string;

		const upd = await api('POST', '/api/invoices', { action: 'update', id: ids.invoice, notes: 'Updated notes' });
		expect(upd.data.notes).toBe('Updated notes');

		const preview = await fetch(`${BASE}/api/invoices/${ids.invoice}/preview`, { headers: { Cookie: cookieHeader() } });
		expect(preview.status).toBe(200);
		expect(preview.headers.get('content-type')).toContain('text/html');

		const pdf = await fetch(`${BASE}/api/invoices/${ids.invoice}/pdf`, { headers: { Cookie: cookieHeader() } });
		expect(pdf.status).toBe(200);
		expect(pdf.headers.get('content-type')).toContain('application/pdf');

		const sent = await api('POST', `/api/invoices/${ids.invoice}/status`, { status: 'sent' });
		expect(sent.data.status).toBe('sent');

		const paid = await api('POST', `/api/invoices/${ids.invoice}/status`, { status: 'paid' });
		expect(paid.data.status).toBe('paid');

		const invalid = await api('POST', `/api/invoices/${ids.invoice}/status`, { status: 'draft' });
		expect(invalid.status).toBe(400);

		// M3 regression: the same invalid transition via the form action must
		// also map ServiceError → fail(400) with the translated message, not
		// the dead `e.message.includes('Cannot transition')` branch that
		// returned fail(500) with a generic internalError.
		const invalidForm = await formAction(`/invoices/${ids.invoice}`, 'status', { status: 'draft' });
		// Kit 3: a failed form action carries its fail() status as the HTTP status
		// (Kit 2 always returned 200). The body still carries the failure data.
		expect(invalidForm.status).toBe(400);
		expect(invalidForm.data.type).toBe('failure');
		expect(invalidForm.data.status).toBe(400);
		const fdStr = invalidForm.data.data as string;
		expect(fdStr).toContain('Cannot transition');
		expect(fdStr).not.toContain('error.invalidStatusTransition');
		expect(fdStr).not.toContain('error.internalError');
	}, 60000);


	it('invoice with percentage + fixed discounts', async () => {
		const inv = await api('POST', '/api/invoices', {
			clientId: ids.client, pricingMode: 'net', currency: 'EUR', language: 'en',
			issueDate: today, dueDate: due,
			items: [{ id: 'd1', name: 'Consulting', description: '', quantity: 1, unit: 'hr', unitPrice: 100000, taxRate: 19, items: [] }],
			discounts: [
				{ type: 'percentage', value: 10, description: '10% loyalty discount' },
				{ type: 'fixed', value: 5000, description: '50 EUR credit' }
			],
			notes: '', footerText: '', templateId: 'kossov-it', templateOptions: {}
		});
		expect(inv.status).toBeLessThan(300);
		const totals = inv.data.totals as Record<string, number>;
		expect(totals.subtotal).toBe(100000);
		expect(totals.discountAmount).toBe(15000);
		expect(totals.subtotalAfterDiscounts).toBe(85000);
		expect(totals.total).toBe(101150);
		ids.discountInvoice = inv.data.id as string;
	}, 15000);


	it('invoice with nested sub-items', async () => {
		const inv = await api('POST', '/api/invoices', {
			clientId: ids.client, pricingMode: 'net', currency: 'EUR', language: 'en',
			issueDate: today, dueDate: due,
			items: [{
				id: 'parent', name: 'Website Project', description: '', quantity: 1, unit: 'project', unitPrice: 0, taxRate: 19,
				items: [
					{ id: 'sub1', name: 'Design', description: '', quantity: 5, unit: 'hrs', unitPrice: 12000, taxRate: 19, items: [] },
					{ id: 'sub2', name: 'Development', description: '', quantity: 20, unit: 'hrs', unitPrice: 10000, taxRate: 19, items: [] }
				]
			}],
			discounts: [], notes: '', footerText: '', templateId: 'kossov-it', templateOptions: {}
		});
		expect(inv.status).toBeLessThan(300);
		const totals = inv.data.totals as Record<string, number>;
		expect(totals.subtotal).toBe(260000);
		expect(totals.total).toBe(309400);
	}, 15000);


	it('credit note from paid invoice', async () => {
		const inv = await api('POST', '/api/invoices', {
			clientId: ids.client, pricingMode: 'net', currency: 'EUR', language: 'en',
			issueDate: today, dueDate: due,
			items: [{ id: 'cn1', name: 'Service', description: '', quantity: 2, unit: 'hrs', unitPrice: 50000, taxRate: 19, items: [] }],
			discounts: [], notes: '', footerText: '', templateId: 'kossov-it', templateOptions: {}
		});
		const cnInvId = inv.data.id as string;
		await api('POST', `/api/invoices/${cnInvId}/status`, { status: 'sent' });

		const cnRes = await formAction(`/invoices/${cnInvId}`, 'creditNote');
		expect([200, 302, 303]).toContain(cnRes.status);

		const invoices = await api('GET', '/api/invoices');
		const allInvs = invoices.data as unknown as Record<string, unknown>[];
		const creditNote = allInvs.find(i => i.invoiceType === 'creditNote' && i.linkedInvoiceId === cnInvId);
		expect(creditNote).toBeTruthy();
		const cnItems = creditNote!.items as Record<string, unknown>[];
		expect((cnItems[0].quantity as number)).toBeLessThan(0);
		ids.creditNote = creditNote!.id as string;
	}, 30000);


	it('proposal: create, send, convert to invoice', async () => {
		const proposal = await api('POST', '/api/proposals', {
			clientId: ids.client, pricingMode: 'net', currency: 'EUR', language: 'en',
			issueDate: today, validUntil: due,
			items: [{ id: 'p1', name: 'Full Redesign', description: 'Complete site overhaul', quantity: 1, unit: 'project', unitPrice: 500000, taxRate: 19, items: [] }],
			discounts: [{ type: 'percentage', value: 5, description: 'Early bird' }],
			introText: 'Dear valued client', notes: 'Terms apply', footerText: '', templateId: 'kossov-it', templateOptions: {}
		});
		expect(proposal.status).toBeLessThan(300);
		expect(proposal.data.status).toBe('draft');
		ids.proposal = proposal.data.id as string;

		const preview = await fetch(`${BASE}/api/proposals/${ids.proposal}/preview`, { headers: { Cookie: cookieHeader() } });
		expect(preview.status).toBe(200);
		const pdf = await fetch(`${BASE}/api/proposals/${ids.proposal}/pdf`, { headers: { Cookie: cookieHeader() } });
		expect(pdf.status).toBe(200);

		const sendRes = await formAction(`/proposals/${ids.proposal}`, 'status', { status: 'sent' });
		expect([200, 302, 303]).toContain(sendRes.status);

		const convertRes = await formAction(`/proposals/${ids.proposal}`, 'convertToInvoice');
		expect([200, 302, 303]).toContain(convertRes.status);

		const props = await api('GET', '/api/proposals');
		const allProps = props.data as unknown as Record<string, unknown>[];
		const sentProp = allProps.find(p => p.id === ids.proposal);
		expect(sentProp?.status).toBe('accepted');

		const invoices = await api('GET', '/api/invoices');
		const allInvs = invoices.data as unknown as Record<string, unknown>[];
		const convertedInv = allInvs.find(i => {
			const items = i.items as Record<string, unknown>[];
			return items?.[0]?.name === 'Full Redesign';
		});
		expect(convertedInv).toBeTruthy();
		expect(convertedInv!.status).toBe('draft');
	}, 60000);


	it('ticket lifecycle: create, status transitions, convert to invoice', async () => {
		const ticket = await api('POST', '/api/tickets', {
			clientId: ids.client, date: today, startTime: '09:00', hours: 2.5,
			hourlyRate: 10000, title: '', description: '<b>Maintenance</b>', notes: 'Internal'
		});
		expect(ticket.status).toBeLessThan(300);
		expect(ticket.data.ticketNumber).toBe('T-001');
		expect(ticket.data.status).toBe('open');
		ids.ticket = ticket.data.id as string;

		const upd = await api('POST', '/api/tickets', { action: 'update', id: ids.ticket, hours: 3 });
		expect(upd.data.hours).toBe(3);

		const completed = await api('POST', '/api/tickets', { action: 'status', id: ids.ticket, status: 'completed' });
		expect(completed.data.status).toBe('completed');
		const reopened = await api('POST', '/api/tickets', { action: 'status', id: ids.ticket, status: 'open' });
		expect(reopened.data.status).toBe('open');
		await api('POST', '/api/tickets', { action: 'status', id: ids.ticket, status: 'completed' });

		const invRes = await api('POST', '/api/tickets', { action: 'toInvoice', id: ids.ticket, mode: 'new' });
		expect(invRes.status).toBeLessThan(300);
		const items = invRes.data.items as Record<string, unknown>[];
		expect(items[0].unit).toBe('hrs');
		expect((items[0].name as string)).toContain('IT-Support');

		const reConvert = await api('POST', '/api/tickets', { action: 'toInvoice', id: ids.ticket, mode: 'new' });
		expect(reConvert.status).toBe(400);

		const delInvoiced = await api('POST', '/api/tickets', { action: 'delete', id: ids.ticket });
		expect(delInvoiced.status).toBeGreaterThanOrEqual(400);

		const t2 = await api('POST', '/api/tickets', {
			clientId: ids.client, date: today, startTime: '14:00', hours: 1, hourlyRate: 10000, description: 'Follow-up', notes: ''
		});
		ids.ticket2 = t2.data.id as string;
		const appendRes = await api('POST', '/api/tickets', {
			action: 'toInvoice', id: ids.ticket2, mode: 'existing', invoiceId: invRes.data.id as string
		});
		expect(appendRes.status).toBeLessThan(300);
		expect((appendRes.data.items as unknown[]).length).toBe(2);

		const otherClient = await api('POST', '/api/clients', { name: 'Other Client', email: 'other@test.com', address: { street: '3 Test St', city: 'Hamburg', zip: '20095', country: 'DE' } });
		const t3cross = await api('POST', '/api/tickets', {
			clientId: otherClient.data.id as string, date: today, startTime: '15:00', hours: 1, hourlyRate: 10000, description: 'Cross-client', notes: ''
		});
		const crossRes = await api('POST', '/api/tickets', {
			action: 'toInvoice', id: t3cross.data.id as string, mode: 'existing', invoiceId: invRes.data.id as string
		});
		expect(crossRes.status).toBeGreaterThanOrEqual(400);

		const t3 = await api('POST', '/api/tickets', {
			clientId: ids.client, date: today, startTime: '16:00', hours: 0.5, hourlyRate: 10000, description: '', notes: ''
		});
		const delOpen = await api('POST', '/api/tickets', { action: 'delete', id: t3.data.id as string });
		expect(delOpen.status).toBeLessThan(300);
	}, 30000);


	it('German locale: ticket → invoice uses "Std." and German date format', async () => {
		await api('POST', '/api/settings', { section: 'general', data: { language: 'de', currency: 'EUR', dateFormat: 'DD.MM.YYYY', timezone: 'Europe/Berlin' } });

		const deClient = await api('POST', '/api/clients', {
			name: 'Deutsche Firma', email: 'de@test.com', language: 'de',
			address: { street: 'Berliner Str. 1', city: 'Berlin', zip: '10115', country: 'DE' }
		});
		const deClientId = deClient.data.id as string;

		const ticket = await api('POST', '/api/tickets', {
			clientId: deClientId, date: '2026-03-15', startTime: '10:00', hours: 4,
			hourlyRate: 8500, title: '', description: 'Serverwartung', notes: ''
		});
		const ticketId = ticket.data.id as string;
		await api('POST', '/api/tickets', { action: 'status', id: ticketId, status: 'completed' });

		const invRes = await api('POST', '/api/tickets', { action: 'toInvoice', id: ticketId, mode: 'new' });
		expect(invRes.status).toBeLessThan(300);
		const items = invRes.data.items as Record<string, unknown>[];
		expect(items[0].unit).toBe('Std.');
		expect((items[0].name as string)).toMatch(/IT-Support am \d{2}\.\d{2}\.\d{4}/);

		await api('POST', '/api/settings', { section: 'general', data: { language: 'en', currency: 'EUR', dateFormat: 'DD/MM/YYYY', timezone: 'Europe/Amsterdam' } });
	}, 30000);


	it('Kleinunternehmer: invoices have 0% tax', async () => {
		await api('POST', '/api/settings', { section: 'advanced', data: { sepaQrEnabled: false, kleinunternehmer: true, editLock: 'none' } });

		const inv = await api('POST', '/api/invoices', {
			clientId: ids.client, pricingMode: 'net', currency: 'EUR', language: 'en',
			issueDate: today, dueDate: due,
			items: [{ id: 'ku1', name: 'KU Service', description: '', quantity: 1, unit: 'hr', unitPrice: 100000, taxRate: 19, items: [] }],
			discounts: [], notes: '', footerText: '', templateId: 'kossov-it', templateOptions: {}
		});
		expect(inv.status).toBeLessThan(300);
		const totals = inv.data.totals as Record<string, number>;
		expect(totals.totalTaxes).toBe(0);
		expect(totals.total).toBe(100000); // net = gross
		expect(inv.data.kleinunternehmer).toBe(true);

		await api('POST', '/api/settings', { section: 'advanced', data: { sepaQrEnabled: false, kleinunternehmer: false, editLock: 'none' } });
	}, 15000);


	it('expense: create, update, delete via form actions', async () => {
		const createRes = await formAction('/expenses', 'create', {
			date: today, description: 'Office supplies', amount: '4999',
			taxAmount: '950', currency: 'EUR', category: 'office', vendor: 'Staples', notes: 'Pens and paper'
		});
		expect([200, 303]).toContain(createRes.status);

		const searchRes = await fetch(`${BASE}/api/search?q=Office+supplies`, { headers: { Cookie: cookieHeader() } });
		const searchData = await searchRes.json() as Record<string, unknown>[];
		const expense = searchData.find(r => r.type === 'expense');
		expect(expense).toBeTruthy();

		if (expense) {
			const delRes = await formAction('/expenses', 'delete', { id: expense.id as string });
			expect([200, 303]).toContain(delRes.status);
		}
	}, 15000);


	it('invoice with mixed tax rates (19% + 7%): tax subtotals grouped correctly', async () => {
		const inv = await api('POST', '/api/invoices', {
			clientId: ids.client, pricingMode: 'net', currency: 'EUR', language: 'en',
			issueDate: today, dueDate: due,
			items: [
				{ id: 'mx1', name: 'Software', description: '', quantity: 1, unit: 'license', unitPrice: 100000, taxRate: 19, items: [] },
				{ id: 'mx2', name: 'Book', description: '', quantity: 2, unit: 'pc', unitPrice: 2000, taxRate: 7, items: [] }
			],
			discounts: [], notes: '', footerText: '', templateId: 'kossov-it', templateOptions: {}
		});
		expect(inv.status).toBeLessThan(300);
		const totals = inv.data.totals as Record<string, unknown>;
		expect(totals.subtotal).toBe(104000);
		const taxSubs = totals.taxSubtotals as Record<string, number>[];
		expect(taxSubs.length).toBe(2);
		const tax19 = taxSubs.find(t => t.rate === 19);
		expect(tax19).toBeTruthy();
		expect(tax19!.taxableAmount).toBe(100000);
		expect(tax19!.taxAmount).toBe(19000);
		const tax7 = taxSubs.find(t => t.rate === 7);
		expect(tax7).toBeTruthy();
		expect(tax7!.taxableAmount).toBe(4000);
		expect(tax7!.taxAmount).toBe(280);
		expect(totals.total).toBe(123280);
	}, 15000);


	it('invoice status: cancel and reopen flow', async () => {
		const inv = await api('POST', '/api/invoices', {
			clientId: ids.client, pricingMode: 'net', currency: 'EUR', language: 'en',
			issueDate: today, dueDate: due,
			items: [{ id: 'ca1', name: 'Cancel test', description: '', quantity: 1, unit: 'pc', unitPrice: 5000, taxRate: 19, items: [] }],
			discounts: [], notes: '', footerText: '', templateId: 'kossov-it', templateOptions: {}
		});
		const caId = inv.data.id as string;
		await api('POST', `/api/invoices/${caId}/status`, { status: 'sent' });

		const cancelled = await api('POST', `/api/invoices/${caId}/status`, { status: 'cancelled' });
		expect(cancelled.data.status).toBe('cancelled');

		const reopened = await api('POST', `/api/invoices/${caId}/status`, { status: 'draft' });
		expect(reopened.data.status).toBe('draft');
	}, 15000);


	it('edit lock: blocks editing sent invoices when editLock=sent', async () => {
		await api('POST', '/api/settings', { section: 'advanced', data: { sepaQrEnabled: false, kleinunternehmer: false, editLock: 'sent' } });

		const inv = await api('POST', '/api/invoices', {
			clientId: ids.client, pricingMode: 'net', currency: 'EUR', language: 'en',
			issueDate: today, dueDate: due,
			items: [{ id: 'el1', name: 'Lock test', description: '', quantity: 1, unit: 'pc', unitPrice: 5000, taxRate: 19, items: [] }],
			discounts: [], notes: '', footerText: '', templateId: 'kossov-it', templateOptions: {}
		});
		const elId = inv.data.id as string;
		await api('POST', `/api/invoices/${elId}/status`, { status: 'sent' });

		const editAttempt = await api('POST', '/api/invoices', { action: 'update', id: elId, notes: 'Should fail' });
		expect(editAttempt.status).toBeGreaterThanOrEqual(400);

		await api('POST', '/api/settings', { section: 'advanced', data: { sepaQrEnabled: false, kleinunternehmer: false, editLock: 'none' } });
	}, 15000);


	it('proposal: reject status + duplicate', async () => {
		const prop = await api('POST', '/api/proposals', {
			clientId: ids.client, pricingMode: 'net', currency: 'EUR', language: 'en',
			issueDate: today, validUntil: due,
			items: [{ id: 'rj1', name: 'Rejected work', description: '', quantity: 1, unit: 'project', unitPrice: 300000, taxRate: 19, items: [] }],
			discounts: [], introText: '', notes: '', footerText: '', templateId: 'kossov-it', templateOptions: {}
		});
		const rjId = prop.data.id as string;

		await formAction(`/proposals/${rjId}`, 'status', { status: 'sent' });
		const rejected = await formAction(`/proposals/${rjId}`, 'status', { status: 'rejected' });
		expect([200, 302, 303]).toContain(rejected.status);

		const props = await api('GET', '/api/proposals');
		const allProps = props.data as unknown as Record<string, unknown>[];
		const rjProp = allProps.find(p => p.id === rjId);
		expect(rjProp?.status).toBe('rejected');

		const dupRes = await formAction(`/proposals/${rjId}`, 'duplicate');
		expect([200, 302, 303]).toContain(dupRes.status);
	}, 15000);


	it('catalog items and units CRUD', async () => {
		const unit = await api('POST', '/api/units', { name: 'Stück' });
		expect(unit.status).toBeLessThan(300);
		const unitId = unit.data.id as string;

		const units = await api('GET', '/api/units');
		expect((units.data as unknown as unknown[]).length).toBeGreaterThanOrEqual(1);

		const item = await api('POST', '/api/catalog-items', {
			name: 'Hosting Plan', description: 'Monthly hosting', unitPrice: 2999, unit: 'month', taxRate: 19
		});
		expect(item.status).toBeLessThan(300);
		const itemId = item.data.id as string;

		const upd = await api('POST', '/api/catalog-items', { action: 'update', id: itemId, unitPrice: 3999 });
		expect(upd.data.unitPrice).toBe(3999);

		const del = await api('POST', '/api/catalog-items', { action: 'delete', id: itemId });
		expect(del.status).toBeLessThan(300);

		const delUnit = await api('POST', '/api/units', { action: 'delete', id: unitId });
		expect(delUnit.status).toBeLessThan(300);
	}, 15000);


	it('cross-entity search', async () => {
		const search = async (q: string) => {
			const r = await api('GET', `/api/search?q=${encodeURIComponent(q)}`);
			const results = Array.isArray(r.data) ? r.data : (r.data as unknown as Record<string, unknown>[]);
			return { status: r.status, results: Array.isArray(results) ? results : [] };
		};

		const r1 = await search('Acme');
		expect(r1.status).toBe(200);
		expect(r1.results.length).toBeGreaterThan(0);

		const r2 = await search('Updated notes');
		expect(r2.results.some(r => r.type === 'invoice')).toBe(true);

		const r4 = await search('X');
		expect(r4.results).toEqual([]);
	}, 15000);


	it('monitor CRUD + toggle', async () => {
		const mon = await api('POST', '/api/monitors', {
			name: 'Google DNS', ip: '8.8.8.8', domain: 'dns.google',
			enabled: true, checks: { ping: true, http: false, domainExpiry: false, sslExpiry: false },
			httpExpectedStatus: 200, domainExpiryThresholdDays: 30, sslExpiryThresholdDays: 14
		});
		expect(mon.status).toBeLessThan(300);
		ids.monitor = mon.data.id as string;

		const detail = await api('GET', `/api/monitors/${ids.monitor}`);
		expect((detail.data.monitor as Record<string, unknown>).name).toBe('Google DNS');

		const toggled = await api('POST', '/api/monitors', { action: 'toggle', id: ids.monitor, enabled: false });
		expect(toggled.status).toBeLessThan(300);

		const upd = await api('POST', '/api/monitors', {
			action: 'update', id: ids.monitor, name: 'Google DNS Updated',
			ip: '8.8.8.8', domain: 'dns.google', enabled: false,
			checks: { ping: true, http: false, domainExpiry: false, sslExpiry: false },
			httpExpectedStatus: 200, domainExpiryThresholdDays: 30, sslExpiryThresholdDays: 14
		});
		expect(upd.status).toBeLessThan(300);

		const del = await api('POST', '/api/monitors', { action: 'delete', id: ids.monitor });
		expect(del.status).toBeLessThan(300);
	}, 15000);


	it('settings: update company, verify persistence', async () => {
		const companyUpdate = await api('POST', '/api/settings', {
			section: 'company',
			data: {
				name: 'Updated Corp', email: 'corp@test.com', phone: '+49 30 99999',
				website: 'https://corp.de', taxNumber: 'TAX-123', vatNumber: 'DE999999999',
				registrationNumber: 'HRB 12345',
				address: { street: 'New St 5', city: 'Munich', zip: '80331', state: 'Bayern', country: 'DE' },
				logoUrl: '', bankName: 'Deutsche Bank', bankAccount: '1234567890',
				bankIban: 'DE89370400440532013000', bankSwift: 'COBADEFFXXX', legalInfo: 'Legal notice'
			}
		});
		expect(companyUpdate.status).toBeLessThan(300);

		const settings = await api('GET', '/api/settings');
		const company = (settings.data as Record<string, Record<string, unknown>>).company;
		expect(company.name).toBe('Updated Corp');
		expect(company.bankIban).toBe('DE89370400440532013000');
	}, 15000);


	it('settings: SSRF defence rejects SMTP host that resolves to a blocked IP (M7)', async () => {
		const baseSmtp = {
			port: 587,
			secure: false,
			user: 'user',
			pass: '',
			from: 'noreply@test',
			fromName: 'Test'
		};
		const tpl = { subject: 'x', body: 'y' };
		const baseEmail = {
			invoiceEmail: tpl,
			creditNoteEmail: tpl,
			proposalEmail: tpl,
			reminderEmail: tpl
		};

		// Cloud-metadata IP — must reject
		const meta = await api('POST', '/api/settings', {
			section: 'emails',
			data: { smtp: { ...baseSmtp, host: '169.254.169.254' }, ...baseEmail }
		});
		expect(meta.status).toBe(400);
		expect(JSON.stringify(meta.data)).toMatch(/blocked IP range|169\.254/);

		// Loopback IP — must reject
		const lb = await api('POST', '/api/settings', {
			section: 'emails',
			data: { smtp: { ...baseSmtp, host: '127.0.0.1' }, ...baseEmail }
		});
		expect(lb.status).toBe(400);

		// Hostname that resolves to loopback — must reject
		const localhost = await api('POST', '/api/settings', {
			section: 'emails',
			data: { smtp: { ...baseSmtp, host: 'localhost' }, ...baseEmail }
		});
		expect(localhost.status).toBe(400);

		// Empty host — should still be allowed (initial setup state)
		const empty = await api('POST', '/api/settings', {
			section: 'emails',
			data: { smtp: { ...baseSmtp, host: '' }, ...baseEmail }
		});
		expect(empty.status).toBeLessThan(300);
	}, 15000);

	it('audit log contains entries', async () => {
		const changes = await api('GET', '/api/changes?limit=5');
		const entries = changes.data as unknown as Record<string, unknown>[];
		expect(entries.length).toBeGreaterThan(0);
	}, 10000);


	it('invoice export as ZIP', async () => {
		const invoices = await api('GET', '/api/invoices');
		const allInvs = invoices.data as unknown as Record<string, unknown>[];
		const validIds = allInvs.slice(0, 3).map(i => i.id);

		const exportRes = await fetch(`${BASE}/api/invoices/export`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json', 'Origin': BASE, 'Cookie': cookieHeader() },
			body: JSON.stringify({ ids: validIds })
		});
		if (validIds.length === 1) {
			expect(exportRes.headers.get('content-type')).toContain('application/pdf');
		} else {
			expect(exportRes.headers.get('content-type')).toContain('application/zip');
		}
		expect(exportRes.status).toBe(200);
	}, 60000);


	it('invoice preview contains correct seller, buyer, items, totals', async () => {
		const preview = await fetch(`${BASE}/api/invoices/${ids.invoice}/preview`, { headers: { Cookie: cookieHeader() } });
		const html = await preview.text();

		expect(html).toContain('Test Corp');

		expect(html).toContain('Acme GmbH');

		expect(html).toContain('Web Development');
		expect(html).toContain('Server Setup');

		expect(html).toMatch(/1[.,]249/);

		expect(html).toContain('19');

		const docIdPattern = new RegExp(`${new Date().getFullYear()}-\\d{4}`);
		expect(html).toMatch(docIdPattern);

		const pdf = await fetch(`${BASE}/api/invoices/${ids.invoice}/pdf`, { headers: { Cookie: cookieHeader() } });
		const pdfBuffer = await pdf.arrayBuffer();
		const pdfHeader = String.fromCharCode(...new Uint8Array(pdfBuffer.slice(0, 5)));
		expect(pdfHeader).toBe('%PDF-');
	}, 60000);


	it('invoice with gross pricing mode', async () => {
		const inv = await api('POST', '/api/invoices', {
			clientId: ids.client, pricingMode: 'gross', currency: 'EUR', language: 'en',
			issueDate: today, dueDate: due,
			items: [{ id: 'g1', name: 'Gross item', description: '', quantity: 1, unit: 'pc', unitPrice: 119000, taxRate: 19, items: [] }],
			discounts: [], notes: '', footerText: '', templateId: 'kossov-it', templateOptions: {}
		});
		expect(inv.status).toBeLessThan(300);
		const totals = inv.data.totals as Record<string, number>;
		expect(totals.total).toBe(119000);
		expect(totals.netTotal).toBe(100000);
		expect(totals.totalTaxes).toBe(19000);
	}, 15000);


	it('duplicate invoice', async () => {
		const dupRes = await formAction(`/invoices/${ids.invoice}`, 'duplicate');
		expect([200, 302, 303]).toContain(dupRes.status);

		const invoices = await api('GET', '/api/invoices');
		const allInvs = invoices.data as unknown as Record<string, unknown>[];
		const drafts = allInvs.filter(i => i.status === 'draft');
		expect(drafts.length).toBeGreaterThan(0);
	}, 15000);


	it('recurring invoice: server startup timer generates new invoice from source', async () => {
		let generated: Record<string, unknown> | undefined;
		for (let attempt = 0; attempt < 6; attempt++) {
			await new Promise(r => setTimeout(r, 2000));
			const invoices = (await api('GET', '/api/invoices')).data as unknown as Record<string, unknown>[];
			generated = invoices.find(i =>
				!(i.recurring as Record<string, unknown> | null)?.enabled &&
				(i.items as Record<string, unknown>[])?.some(
					(item: Record<string, unknown>) => item.name === 'Monthly hosting'
				)
			);
			if (generated) break;
		}
		expect(generated).toBeTruthy();
		expect(generated!.status).toBe('draft');
		expect((generated!.totals as Record<string, number>).total).toBe(3569);
	}, 30000);


	it('reports: revenue data matches paid invoices', async () => {
		const reports = await api('GET', `/api/invoices`);
		const allInvs = reports.data as unknown as Record<string, unknown>[];
		const paidInvs = allInvs.filter(i => i.status === 'paid');

		expect(paidInvs.length).toBeGreaterThan(0);

		for (const inv of paidInvs) {
			const totals = inv.totals as Record<string, number>;
			expect(Math.abs(totals.total - totals.netTotal - totals.totalTaxes)).toBeLessThanOrEqual(1);
			expect(totals.subtotalAfterDiscounts).toBe(totals.subtotal - totals.discountAmount);
		}
	}, 15000);


	it('overdue: sent invoice with past due date should be markable', async () => {
		const pastDate = new Date(Date.now() - 7 * 86400000).toISOString().split('T')[0];

		const inv = await api('POST', '/api/invoices', {
			clientId: ids.client, pricingMode: 'net', currency: 'EUR', language: 'en',
			issueDate: pastDate, dueDate: pastDate,
			items: [{ id: 'od1', name: 'Overdue test', description: '', quantity: 1, unit: 'pc', unitPrice: 5000, taxRate: 19, items: [] }],
			discounts: [], notes: '', footerText: '', templateId: 'kossov-it', templateOptions: {}
		});
		const odId = inv.data.id as string;

		await api('POST', `/api/invoices/${odId}/status`, { status: 'sent' });

		const check = await api('GET', '/api/invoices');
		const allInvs = check.data as unknown as Record<string, unknown>[];
		const overdue = allInvs.find(i => i.id === odId);
		expect(overdue).toBeTruthy();
		expect(overdue!.dueDate).toBe(pastDate);
		expect(['sent', 'overdue']).toContain(overdue!.status);
	}, 15000);


	it('custom template: create, update, export, delete', async () => {
		const tmpl = await api('POST', '/api/templates', {
			name: 'Test Template',
			html: '<div class="invoice"><%= documentId %></div>',
			css: '.invoice { font-family: sans-serif; }',
			options: []
		});
		expect(tmpl.status).toBeLessThan(300);
		const tmplId = tmpl.data.id as string;
		expect(tmpl.data.builtIn).toBe(false);

		const upd = await api('POST', '/api/templates', {
			action: 'update', id: tmplId, name: 'Updated Template',
			html: '<div class="invoice v2"><%= documentId %></div>',
			css: '.invoice.v2 { color: #333; }', options: []
		});
		expect(upd.status).toBeLessThan(300);

		const exportRes = await fetch(`${BASE}/api/templates/${tmplId}/export`, { headers: { Cookie: cookieHeader() } });
		expect(exportRes.status).toBe(200);
		const exported = await exportRes.json();
		expect(exported.name).toBe('Updated Template');
		expect(exported.html).toContain('v2');

		const list = await api('GET', '/api/templates');
		const templates = list.data as unknown as Record<string, unknown>[];
		expect(templates.some(t => t.id === 'kossov-it' && t.builtIn === true)).toBe(true);
		expect(templates.some(t => t.id === tmplId && t.builtIn === false)).toBe(true);

		const del = await api('POST', '/api/templates', { action: 'delete', id: tmplId });
		expect(del.status).toBeLessThan(300);

		const delBuiltin = await api('POST', '/api/templates', { action: 'delete', id: 'kossov-it' });
		expect(delBuiltin.status).toBeGreaterThanOrEqual(400);
	}, 15000);


	it('backup: create, preview, restore', async () => {
		const createBk = await api('POST', '/api/backups', { action: 'create' });
		expect(createBk.status).toBeLessThan(300);
		const filename = createBk.data.filename as string;
		expect(filename).toMatch(/^backup-/);

		const preview = await api('POST', '/api/backups', { action: 'restore_preview', filename });
		expect(preview.status).toBeLessThan(300);
		expect(preview.data.backupTimestamp).toBeTruthy();

		const restore = await api('POST', '/api/backups', { action: 'restore', filename, password: 'Testpassword123' });
		expect(restore.status).toBeLessThan(300);

		const login = await api('POST', '/api/auth/login', { email: 'test@test.com', password: 'Testpassword123' });
		expect(login.data.email).toBe('test@test.com');

		const me = await api('GET', '/api/auth/me');
		expect(me.data.email).toBe('test@test.com');
	}, 30000);


	it('password change + re-login', async () => {
		const changePw = await api('POST', '/api/auth/password', {
			currentPassword: 'Testpassword123', newPassword: 'Newpassword456'
		});
		expect(changePw.status).toBeLessThan(300);

		const loginRes = await api('POST', '/api/auth/login', { email: 'test@test.com', password: 'Newpassword456' });
		expect(loginRes.data.email).toBe('test@test.com');

		const wrongPw = await api('POST', '/api/auth/password', {
			currentPassword: 'Testpassword123', newPassword: 'Anotherpw1'
		});
		expect(wrongPw.status).toBe(403);
	}, 15000);


	it('email: validation, rate limiting, SMTP-not-configured', async () => {
		const noTo = await api('POST', '/api/emails', { subject: 'Test', body: 'Hi' });
		expect(noTo.status).toBe(400);

		const noSmtp = await api('POST', '/api/emails', {
			to: 'test@example.com', subject: 'Test Subject', body: '<p>Hello</p>'
		});
		expect(noSmtp.status).toBe(502);
		const errMsg = noSmtp.data.error as string;
		expect(errMsg).toBeTruthy();
		expect(errMsg).not.toMatch(/ECONNREFUSED.*\d+\.\d+\.\d+\.\d+/); // No raw IPs

		const testConn = await api('POST', '/api/emails', { action: 'test' });
		expect(testConn.data.ok).toBe(false);
		expect(testConn.data.error).toContain('No SMTP settings configured');

		const sendWithAttach = await api('POST', '/api/emails', {
			to: 'test@example.com', subject: 'Invoice', body: 'See attached',
			attachmentId: ids.invoice, attachmentType: 'invoice'
		});
		expect(sendWithAttach.status).toBe(502);

		const badAttach = await api('POST', '/api/emails', {
			to: 'test@example.com', subject: 'Test', body: 'Hi',
			attachmentId: 'nonexistent', attachmentType: 'invoice'
		});
		expect(badAttach.status).toBe(404);
	}, 30000);


	it('expense with receipt file upload', async () => {
		const createRes = await formAction('/expenses', 'create', {
			date: today, description: 'Office chair', amount: '29900',
			taxAmount: '5681', currency: 'EUR', category: 'equipment', vendor: 'IKEA', notes: ''
		});
		expect([200, 303]).toContain(createRes.status);

		const searchRes = await fetch(`${BASE}/api/search?q=Office+chair`, { headers: { Cookie: cookieHeader() } });
		const results = await searchRes.json() as Record<string, unknown>[];
		const expense = results.find(r => r.type === 'expense');
		expect(expense).toBeTruthy();
		const expenseId = expense!.id as string;

		const pngSignature = new Uint8Array([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]);
		const ihdr = new Uint8Array([
			0x00, 0x00, 0x00, 0x0D, // length = 13
			0x49, 0x48, 0x44, 0x52, // "IHDR"
			0x00, 0x00, 0x00, 0x01, // width = 1
			0x00, 0x00, 0x00, 0x01, // height = 1
			0x08, 0x02,             // bit_depth=8, color_type=RGB
			0x00, 0x00, 0x00,       // compression, filter, interlace
			0x90, 0x77, 0x53, 0xDE  // CRC
		]);
		const pngBuffer = new Uint8Array([...pngSignature, ...ihdr]);
		const pngBlob = new Blob([pngBuffer], { type: 'image/png' });

		const formData = new FormData();
		formData.set('id', expenseId);
		formData.set('date', today);
		formData.set('description', 'Office chair');
		formData.set('amount', '29900');
		formData.set('taxAmount', '5681');
		formData.set('currency', 'EUR');
		formData.set('category', 'equipment');
		formData.set('vendor', 'IKEA');
		formData.set('notes', '');
		formData.set('receipt', pngBlob, 'receipt.png');

		const uploadRes = await fetch(`${BASE}/expenses?/update`, {
			method: 'POST',
			headers: { 'Origin': BASE, 'Cookie': cookieHeader() },
			body: formData,
			redirect: 'manual'
		});
		extractCookies(uploadRes);
		expect([200, 303]).toContain(uploadRes.status);

		const receiptRes = await fetch(`${BASE}/api/receipts?filename=${expenseId}.png`, { headers: { Cookie: cookieHeader() } });
		expect([200, 400, 404]).toContain(receiptRes.status);

		await formAction('/expenses', 'delete', { id: expenseId });
	}, 15000);


	it('client deletion guards', async () => {
		const delClient = await api('POST', '/api/clients', { action: 'delete', id: ids.client });
		expect(delClient.status).toBe(403);

		const delClient2 = await api('POST', '/api/clients', { action: 'delete', id: ids.client2 });
		expect(delClient2.status).toBeLessThan(300);
	}, 30000);


	it('MFA enable → login challenge → verify → disable', async () => {
		const totp = await import('../../src/lib/server/totp.js');
		const secret = totp.generateTotpSecret();
		const code = () => totp.totp(secret, Date.now());

		const initRes = await api('POST', '/api/auth/mfa', {
			action: 'init',
			currentPassword: 'Newpassword456'
		});
		expect(initRes.status).toBe(200);
		expect(typeof initRes.data.secret).toBe('string');
		expect(typeof initRes.data.qrDataUrl).toBe('string');
		expect((initRes.data.recoveryCodes as string[]).length).toBe(10);

		// across the array. Each entry must hash to a distinct value.
		const recoveryCodes = ['AAAA2222', 'BBBB2222', 'CCCC2222', 'DDDD2222', 'EEEE2222',
			'FFFF2222', 'GGGG2222', 'HHHH2222', 'IIII2222', 'JJJJ2222'];

		// A1 — enable requires currentPassword (cookie-only attacker can no
		// longer plant their own TOTP secret).
		const enableRes = await api('POST', '/api/auth/mfa', {
			action: 'enable',
			currentPassword: 'Newpassword456',
			secret,
			code: code(),
			recoveryCodes
		});
		expect(enableRes.status).toBe(200);
		expect(enableRes.data.sessionRevoked).toBe(true);


		await clearRateLimits();
		const step1 = await api('POST', '/api/auth/login', {
			email: 'test@test.com',
			password: 'Newpassword456'
		});
		expect(step1.status).toBe(200);
		expect(step1.data.mfaRequired).toBe(true);
		const mfaToken = step1.data.mfaToken as string;
		expect(typeof mfaToken).toBe('string');

		// A2 — wrong code on step 2 burns the mfaToken (it must be single-use
		// regardless of outcome). Reset rate-limit buckets first so the
		// per-email cap (3/15min) doesn't trip before the assertion runs.
		await clearRateLimits();
		const wrong = await api('POST', '/api/auth/login', {
			email: 'test@test.com',
			password: 'Newpassword456',
			mfaToken,
			mfaCode: '000000'
		});
		expect(wrong.status).toBe(401);

		// Replay attempt with the same (now-burnt) token must fail.
		const replay = await api('POST', '/api/auth/login', {
			email: 'test@test.com',
			password: 'Newpassword456',
			mfaToken,
			mfaCode: code()
		});
		expect(replay.status).toBe(401);

		// New step-1 → fresh token, completes step-2 normally.
		await clearRateLimits();
		const step1b = await api('POST', '/api/auth/login', {
			email: 'test@test.com',
			password: 'Newpassword456'
		});
		expect(step1b.data.mfaRequired).toBe(true);
		const step2 = await api('POST', '/api/auth/login', {
			email: 'test@test.com',
			password: 'Newpassword456',
			mfaToken: step1b.data.mfaToken as string,
			mfaCode: code()
		});
		expect(step2.status).toBe(200);
		expect(step2.data.email).toBe('test@test.com');

		await api('POST', '/api/auth/logout');
		await clearRateLimits();
		const r1 = await api('POST', '/api/auth/login', {
			email: 'test@test.com',
			password: 'Newpassword456'
		});
		expect(r1.data.mfaRequired).toBe(true);
		const r2 = await api('POST', '/api/auth/login', {
			email: 'test@test.com',
			password: 'Newpassword456',
			mfaToken: r1.data.mfaToken,
			mfaCode: recoveryCodes[0]
		});
		expect(r2.status).toBe(200);

		await api('POST', '/api/auth/logout');
		await clearRateLimits();
		const r3 = await api('POST', '/api/auth/login', {
			email: 'test@test.com',
			password: 'Newpassword456'
		});
		// r4 uses an already-consumed recovery code → fails. A2 also burns
		// the mfaToken on this failed attempt, so r5 needs a fresh step-1.
		const r4 = await api('POST', '/api/auth/login', {
			email: 'test@test.com',
			password: 'Newpassword456',
			mfaToken: r3.data.mfaToken,
			mfaCode: recoveryCodes[0]
		});
		expect(r4.status).toBe(401);

		await clearRateLimits();
		const r4b = await api('POST', '/api/auth/login', {
			email: 'test@test.com',
			password: 'Newpassword456'
		});
		const r5 = await api('POST', '/api/auth/login', {
			email: 'test@test.com',
			password: 'Newpassword456',
			mfaToken: r4b.data.mfaToken,
			mfaCode: recoveryCodes[1]
		});
		expect(r5.status).toBe(200);
		const status2 = await api('GET', '/api/auth/mfa');
		expect(status2.data.recoveryCodesRemaining).toBe(8);

		// H1 regression: the /login form action must also consume the MFA nonce.
		// Stay logged in to preserve subsequent disable-flow assertions; createSession
		// rotates the existing session in place.
		await clearRateLimits();
		const faPre = await api('POST', '/api/auth/login', {
			email: 'test@test.com',
			password: 'Newpassword456'
		});
		expect(faPre.data.mfaRequired).toBe(true);
		const faTokenSingle = faPre.data.mfaToken as string;
		const faOk = await formAction('/login', '', {
			email: 'test@test.com',
			password: 'Newpassword456',
			mfaToken: faTokenSingle,
			mfaCode: code()
		});
		expect(faOk.status).toBe(200);
		expect(faOk.data.type).toBe('redirect');
		expect(faOk.data.location).toBe('/dashboard');
		const faReplay = await formAction('/login', '', {
			email: 'test@test.com',
			password: 'Newpassword456',
			mfaToken: faTokenSingle,
			mfaCode: code()
		});
		// Kit 3: failed form actions carry their fail() status as the HTTP status.
		expect(faReplay.status).toBe(401);
		expect(faReplay.data.type).toBe('failure');
		expect(faReplay.data.status).toBe(401);

		// Password change while MFA is active — must require a fresh second factor.
		// The step-up replay cache is cleared between sub-tests so the prior
		// login-consumed TOTP doesn't collide with the step-up TOTP within
		// the same 30s window. Password is rotated to a fresh value and back
		// so subsequent tests in this suite still see Newpassword456.
		await clearStepUpCache();
		const pwNoMfa = await api('POST', '/api/auth/password', {
			currentPassword: 'Newpassword456',
			newPassword: 'Newpassword789'
		});
		expect(pwNoMfa.status).toBe(403);

		const pwBadMfa = await api('POST', '/api/auth/password', {
			currentPassword: 'Newpassword456',
			newPassword: 'Newpassword789',
			mfaCode: '000000'
		});
		expect(pwBadMfa.status).toBe(401);

		await clearStepUpCache();
		const pwGood = await api('POST', '/api/auth/password', {
			currentPassword: 'Newpassword456',
			newPassword: 'Newpassword789',
			mfaCode: code()
		});
		expect(pwGood.status).toBe(200);

		await clearRateLimits();
		const reLoginPre = await api('POST', '/api/auth/login', {
			email: 'test@test.com',
			password: 'Newpassword789'
		});
		expect(reLoginPre.data.mfaRequired).toBe(true);
		await clearStepUpCache();
		const reLogin = await api('POST', '/api/auth/login', {
			email: 'test@test.com',
			password: 'Newpassword789',
			mfaToken: reLoginPre.data.mfaToken as string,
			mfaCode: code()
		});
		expect(reLogin.status).toBe(200);

		// Roll the password back so downstream tests in this describe block
		// (which assert against 'Newpassword456') still see the expected creds.
		await clearStepUpCache();
		const pwRollback = await api('POST', '/api/auth/password', {
			currentPassword: 'Newpassword789',
			newPassword: 'Newpassword456',
			mfaCode: code()
		});
		expect(pwRollback.status).toBe(200);

		await clearRateLimits();
		const reLoginPre2 = await api('POST', '/api/auth/login', {
			email: 'test@test.com',
			password: 'Newpassword456'
		});
		expect(reLoginPre2.data.mfaRequired).toBe(true);
		await clearStepUpCache();
		const reLogin2 = await api('POST', '/api/auth/login', {
			email: 'test@test.com',
			password: 'Newpassword456',
			mfaToken: reLoginPre2.data.mfaToken as string,
			mfaCode: code()
		});
		expect(reLogin2.status).toBe(200);

		await clearStepUpCache();
		const badDisable = await api('POST', '/api/auth/mfa', {
			action: 'disable',
			currentPassword: 'Newpassword456',
			code: '000000'
		});
		expect(badDisable.status).toBe(401);

		await clearStepUpCache();
		const goodDisable = await api('POST', '/api/auth/mfa', {
			action: 'disable',
			currentPassword: 'Newpassword456',
			code: code()
		});
		expect(goodDisable.status).toBe(200);
		expect(goodDisable.data.sessionRevoked).toBe(true);

		await clearRateLimits();
		const plain = await api('POST', '/api/auth/login', {
			email: 'test@test.com',
			password: 'Newpassword456'
		});
		expect(plain.status).toBe(200);
		expect(plain.data.email).toBe('test@test.com');

		const finalStatus = await api('GET', '/api/auth/mfa');
		expect(finalStatus.data.enabled).toBe(false);
	}, 30000);

	it('MFA: cannot init without correct password', async () => {
		await clearRateLimits();
		const res = await api('POST', '/api/auth/mfa', {
			action: 'init',
			currentPassword: 'wrong-password-1'
		});
		expect(res.status).toBe(403);
	});

	it('MFA: enable rejects wrong code for the secret', async () => {
		const totp = await import('../../src/lib/server/totp.js');
		const secret = totp.generateTotpSecret();
		const recoveryCodes = Array.from({ length: 10 }, (_, i) => `R${i.toString().padStart(7, '0')}`);

		const res = await api('POST', '/api/auth/mfa', {
			action: 'enable',
			currentPassword: 'Newpassword456',
			secret,
			code: '000000',
			recoveryCodes
		});
		expect(res.status).toBe(401);
	});


	it('login rate limit: per-email resets on success, global does not', async () => {
		await clearRateLimits();
		const wrongCreds = { email: 'test@test.com', password: 'wrong' };
		const rightCreds = { email: 'test@test.com', password: 'Newpassword456' };

		for (let i = 0; i < 2; i++) {
			const r = await api('POST', '/api/auth/login', wrongCreds);
			expect(r.status).toBe(401);
		}
		const ok = await api('POST', '/api/auth/login', rightCreds);
		expect(ok.status).toBe(200);

		for (let i = 0; i < 2; i++) {
			const r = await api('POST', '/api/auth/login', wrongCreds);
			expect(r.status).toBe(401);
		}
		const ok2 = await api('POST', '/api/auth/login', rightCreds);
		expect(ok2.status).toBe(200);

		let saw429 = false;
		for (let cycle = 0; cycle < 40 && !saw429; cycle++) {
			for (let i = 0; i < 2; i++) {
				const r = await api('POST', '/api/auth/login', wrongCreds);
				if (r.status === 429) { saw429 = true; break; }
				expect(r.status).toBe(401);
			}
			if (saw429) break;
			const login = await api('POST', '/api/auth/login', rightCreds);
			if (login.status === 429) { saw429 = true; break; }
			expect(login.status).toBe(200);
		}
		expect(saw429, 'global rate limit should eventually trigger 429').toBe(true);
	}, 30000);

});


describe('RMM Agents', () => {
	let enrollmentToken: string;
	let agentBearerToken: string;
	let agentId: string;

	async function agentApi(method: string, path: string, body?: unknown, token?: string): Promise<{ status: number; data: Record<string, unknown> }> {
		const headers: Record<string, string> = { 'Content-Type': 'application/json' };
		if (token) headers['Authorization'] = `Bearer ${token}`;
		const res = await fetch(`${BASE}${path}`, {
			method,
			headers,
			body: body ? JSON.stringify(body) : undefined,
			redirect: 'manual'
		});
		const text = await res.text();
		let data: Record<string, unknown> = {};
		try { data = JSON.parse(text); } catch { data = { raw: text }; }
		return { status: res.status, data };
	}

	it('should generate an enrollment token', async () => {
		const res = await api('POST', '/api/agents/enrollment-tokens', { name: 'test-agent' });
		expect(res.status).toBe(201);
		expect(res.data.token).toBeDefined();
		expect(typeof res.data.token).toBe('string');
		enrollmentToken = res.data.token as string;
	});

	it('should list enrollment tokens', async () => {
		const res = await api('GET', '/api/agents/enrollment-tokens');
		expect(res.status).toBe(200);
		expect(Array.isArray(res.data)).toBe(true);
	});

	it('should reject enrollment with invalid token', async () => {
		const res = await agentApi('POST', '/api/rmm/enroll', {
			token: 'invalid-token-abc',
			hostname: 'test-host',
			os: 'linux',
			arch: 'amd64',
			hmacSecret: 'deadbeefcafebabedeadbeefcafebabedeadbeefcafebabedeadbeefcafebabe'
		});
		expect(res.status).toBe(401);
	});

	it('should reject enrollment when hmacSecret is missing (downgrade protection)', async () => {
		// omits it must be rejected BEFORE the service layer would otherwise
		const tok = await api('POST', '/api/agents/enrollment-tokens', { name: 'no-hmac' });
		const res = await agentApi('POST', '/api/rmm/enroll', {
			token: tok.data.token as string,
			hostname: 'no-hmac-host',
			os: 'linux',
			arch: 'amd64'
		});
		expect(res.status).toBe(400);
	});

	const agentHmac = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';

	it('should enroll agent with valid token + hmacSecret', async () => {
		const res = await agentApi('POST', '/api/rmm/enroll', {
			token: enrollmentToken,
			hostname: 'test-host',
			os: 'linux',
			arch: 'amd64',
			osVersion: 'Ubuntu 22.04',
			agentVersion: '0.1.0',
			hmacSecret: agentHmac
		});
		expect(res.status).toBe(201);
		expect(res.data.token).toBeDefined();
		expect(res.data.agentId).toBeDefined();
		agentBearerToken = res.data.token as string;
		agentId = res.data.agentId as string;
	});

	it('should reject enrollment with low-entropy hmacSecret', async () => {
		const tok = await api('POST', '/api/agents/enrollment-tokens', { name: 'weak-hmac' });
		const res = await agentApi('POST', '/api/rmm/enroll', {
			token: tok.data.token as string,
			hostname: 'weak-hmac-host',
			os: 'linux',
			arch: 'amd64',
			osVersion: 'x',
			agentVersion: '0.1.0',
			hmacSecret: 'abc123' // too short; schema should reject
		});
		expect(res.status).toBe(400);
	});

	it('should accept enrollment for windows agents', async () => {
		const tok = await api('POST', '/api/agents/enrollment-tokens', { name: 'win-test' });
		const res = await agentApi('POST', '/api/rmm/enroll', {
			token: tok.data.token as string,
			hostname: 'win-host',
			os: 'windows',
			arch: 'amd64',
			osVersion: 'Windows 11 23H2',
			agentVersion: '0.1.0',
			hmacSecret: 'fedcba9876543210fedcba9876543210fedcba9876543210fedcba9876543210'
		});
		expect(res.status).toBe(201);
		expect(res.data.agentId).toBeDefined();
		await api('POST', '/api/agents', { action: 'delete', id: res.data.agentId });
	});

	it('should reject enrollment with already-used token', async () => {
		const res = await agentApi('POST', '/api/rmm/enroll', {
			token: enrollmentToken,
			hostname: 'another-host',
			os: 'linux',
			arch: 'amd64',
			hmacSecret: 'fedcba9876543210fedcba9876543210fedcba9876543210fedcba9876543210'
		});
		expect(res.status).toBe(401);
	});

	it('should reject check-in without bearer token', async () => {
		const res = await agentApi('POST', '/api/rmm/checkin', { metrics: {} });
		expect(res.status).toBe(401);
	});

	it('should accept check-in with valid bearer token', async () => {
		const res = await agentApi('POST', '/api/rmm/checkin', {
			metrics: {
				cpuPercent: 25.5,
				memoryUsedBytes: 4000000000,
				memoryTotalBytes: 8000000000,
				diskUsedBytes: 100000000000,
				diskTotalBytes: 500000000000,
				loadAvg1: 1.5,
				loadAvg5: 1.2,
				loadAvg15: 0.8,
				uptimeSeconds: 86400
			},
			hostname: 'test-host',
			osVersion: 'Ubuntu 22.04',
			agentVersion: '0.1.0'
		}, agentBearerToken);
		expect(res.status).toBe(200);
		expect(res.data.commands).toBeDefined();
		expect(res.data.checkinInterval).toBeDefined();
	});

	it('should list agents via UI API', async () => {
		const res = await api('GET', '/api/agents');
		expect(res.status).toBe(200);
		const agents = res.data as unknown as Array<Record<string, unknown>>;
		expect(Array.isArray(agents)).toBe(true);
		expect(agents.length).toBeGreaterThanOrEqual(1);
		const agent = agents.find(a => a.id === agentId);
		expect(agent).toBeDefined();
		expect(agent!.hostname).toBe('test-host');
		expect(agent!.os).toBe('linux');
		expect(agent!.status).toBe('online');
	});

	it('should get agent detail with metrics', async () => {
		const res = await api('GET', `/api/agents/${agentId}`);
		expect(res.status).toBe(200);
		expect(res.data.agent).toBeDefined();
		expect(res.data.metrics).toBeDefined();
	});

	it('should dispatch a command', async () => {
		const res = await api('POST', `/api/agents/${agentId}/commands`, {
			type: 'shell',
			payload: { command: 'echo hello' },
			timeoutSeconds: 30
		});
		expect(res.status).toBe(201);
		expect(res.data.id).toBeDefined();
		expect(res.data.type).toBe('shell');
		expect(res.data.status).toBe('pending');
	});

	it('should return pending command in check-in response with HMAC-verifiable fields', async () => {
		const res = await agentApi('POST', '/api/rmm/checkin', {}, agentBearerToken);
		expect(res.status).toBe(200);
		const cmds = res.data.commands as unknown as Array<Record<string, unknown>>;
		expect(cmds.length).toBeGreaterThanOrEqual(1);
		const c = cmds[0];
		expect(c.type).toBe('shell');

		expect(typeof c.id).toBe('string');
		expect(typeof c.agentId).toBe('string');
		expect(c.agentId).toBe(agentId);
		expect(typeof c.payloadRaw).toBe('string');
		expect(typeof c.signature).toBe('string');
		expect(typeof c.issuedAt).toBe('string');
		expect(c.signature as string).toMatch(/^[0-9a-f]{64}$/);

		const crypto = await import('node:crypto');
		const msg = `${c.id}:${c.agentId}:${c.type}:${c.payloadRaw}:${c.issuedAt}`;
		const expected = crypto.createHmac('sha256', agentHmac).update(msg).digest('hex');
		expect(c.signature).toBe(expected);
	});

	it('should accept command result in check-in', async () => {
		const histRes = await api('GET', `/api/agents/${agentId}/commands?limit=1`);
		expect(histRes.status).toBe(200);
		const commands = histRes.data as unknown as Array<Record<string, unknown>>;
		const cmdId = commands[0].id as string;

		const res = await agentApi('POST', '/api/rmm/checkin', {
			commandResults: [{
				id: cmdId,
				status: 'completed',
				exitCode: 0,
				stdout: 'hello\n',
				stderr: '',
				startedAt: new Date().toISOString(),
				completedAt: new Date().toISOString()
			}]
		}, agentBearerToken);
		expect(res.status).toBe(200);
	});

	it('should update agent name', async () => {
		const res = await api('POST', '/api/agents', {
			action: 'update',
			id: agentId,
			name: 'renamed-agent'
		});
		expect(res.status).toBe(200);
		expect(res.data.name).toBe('renamed-agent');
	});

	it('should persist rebootRequired flag from Windows metrics', async () => {
		const res = await agentApi('POST', '/api/rmm/checkin', {
			metrics: {
				cpuPercent: 5,
				memoryUsedBytes: 1000, memoryTotalBytes: 2000,
				diskUsedBytes: 1000, diskTotalBytes: 2000,
				loadAvg1: null, loadAvg5: null, loadAvg15: null,
				uptimeSeconds: 100,
				rebootRequired: true
			}
		}, agentBearerToken);
		expect(res.status).toBe(200);

		const detail = await api('GET', `/api/agents/${agentId}`);
		expect(detail.status).toBe(200);
		expect(detail.data.agent).toMatchObject({ rebootRequired: true });
	});

	it('should get packages (empty initially)', async () => {
		const res = await api('GET', `/api/agents/${agentId}/packages`);
		expect(res.status).toBe(200);
	});

	it('should get services (empty initially)', async () => {
		const res = await api('GET', `/api/agents/${agentId}/services`);
		expect(res.status).toBe(200);
	});

	it('should dispatch service_action and return HMAC-verifiable signed command', async () => {
		const disp = await api('POST', `/api/agents/${agentId}/commands`, {
			type: 'service_action',
			payload: { service: 'nginx', action: 'restart' },
			timeoutSeconds: 60
		});
		expect(disp.status).toBe(201);
		expect(disp.data.type).toBe('service_action');

		const check = await agentApi('POST', '/api/rmm/checkin', {}, agentBearerToken);
		const cmds = check.data.commands as unknown as Array<Record<string, unknown>>;
		const svc = cmds.find(c => c.type === 'service_action');
		expect(svc).toBeTruthy();
		expect(svc!.payloadRaw).toContain('nginx');
		expect(svc!.payloadRaw).toContain('restart');

		const crypto = await import('node:crypto');
		const msg = `${svc!.id}:${svc!.agentId}:${svc!.type}:${svc!.payloadRaw}:${svc!.issuedAt}`;
		const expected = crypto.createHmac('sha256', agentHmac).update(msg).digest('hex');
		expect(svc!.signature).toBe(expected);
	});

	it('should reject service_action with shell metacharacters in service name', async () => {
		// must reject injection attempts at the boundary so they never reach
		const bad = [
			'nginx; rm -rf /',
			'nginx && whoami',
			'nginx|cat /etc/passwd',
			'$(whoami)',
			'../etc/passwd',
			'',
			'-rf'
		];
		for (const service of bad) {
			const res = await api('POST', `/api/agents/${agentId}/commands`, {
				type: 'service_action',
				payload: { service, action: 'start' },
				timeoutSeconds: 60
			});
			expect(res.status, `accepted bad service name ${JSON.stringify(service)}`).toBeGreaterThanOrEqual(400);
		}
	});

	it('should reject service_action with invalid action', async () => {
		const res = await api('POST', `/api/agents/${agentId}/commands`, {
			type: 'service_action',
			payload: { service: 'nginx', action: 'destroy' },
			timeoutSeconds: 60
		});
		expect(res.status).toBeGreaterThanOrEqual(400);
	});

	it('should dispatch software_update / os_update / check_os_updates (CHECK constraint)', async () => {
		for (const type of ['software_update', 'os_update', 'check_os_updates'] as const) {
			const res = await api('POST', `/api/agents/${agentId}/commands`, {
				type,
				payload: {},
				timeoutSeconds: 600
			});
			expect(res.status, `failed to dispatch ${type}`).toBe(201);
			expect(res.data.type).toBe(type);
		}
	});


	it('should ingest events from check-in and surface them via /events', async () => {
		const occurredAt = new Date().toISOString();
		const ingestRes = await agentApi('POST', '/api/rmm/checkin', {
			events: [
				{ level: 'error', source: 'sshd.service', message: 'Failed password for invalid user', occurredAt },
				{ level: 'warning', source: 'kernel', message: 'CPU temperature high', occurredAt },
				{ level: 'critical', source: 'docker', message: 'Container OOM-killed', occurredAt }
			]
		}, agentBearerToken);
		expect(ingestRes.status).toBe(200);

		const list = await api('GET', `/api/agents/${agentId}/events?limit=50`);
		expect(list.status).toBe(200);
		const arr = list.data as unknown as Array<Record<string, unknown>>;
		expect(arr.length).toBeGreaterThanOrEqual(3);
		expect(arr.some(e => e.message === 'Container OOM-killed' && e.level === 'critical')).toBe(true);
	});

	it('should reject events with unknown level (Zod boundary)', async () => {
		const occurredAt = new Date().toISOString();
		const res = await agentApi('POST', '/api/rmm/checkin', {
			events: [
				{ level: 'info', source: 'x', message: 'should be rejected', occurredAt }
			]
		}, agentBearerToken);
		expect(res.status).toBe(400);
	});


	it('should create + list + toggle + delete schedules and reject bad input', async () => {
		const created = await api('POST', `/api/agents/${agentId}/schedules`, {
			name: 'Weekly hosting check',
			type: 'shell',
			payload: { command: 'uptime' },
			cronExpression: '0 9 * * 1',
			timeoutSeconds: 60
		});
		expect(created.status).toBe(201);
		expect(created.data.name).toBe('Weekly hosting check');
		expect(typeof created.data.nextRunAt).toBe('string');
		const id = created.data.id as string;

		const list = await api('GET', `/api/agents/${agentId}/schedules`);
		const arr = list.data as unknown as Array<Record<string, unknown>>;
		expect(arr.find(s => s.id === id)).toBeTruthy();

		const updated = await api('POST', `/api/agents/${agentId}/schedules`, {
			action: 'update',
			id,
			name: 'Daily uptime',
			cronExpression: '0 3 * * *',
			type: 'shell',
			payload: { command: 'uptime -p' }
		});
		expect(updated.status).toBe(200);
		expect(updated.data.cronExpression).toBe('0 3 * * *');

		const toggled = await api('POST', `/api/agents/${agentId}/schedules`, {
			action: 'toggle', id, enabled: false
		});
		expect(toggled.status).toBe(200);
		expect(toggled.data.enabled).toBe(false);

		const badCron = await api('POST', `/api/agents/${agentId}/schedules`, {
			name: 'Bad cron',
			type: 'shell',
			payload: { command: 'echo' },
			cronExpression: 'not-a-cron'
		});
		expect(badCron.status).toBe(400);

		const badType = await api('POST', `/api/agents/${agentId}/schedules`, {
			name: 'Bad type',
			type: 'rm-rf',
			payload: {},
			cronExpression: '* * * * *'
		});
		expect(badType.status).toBe(400);

		const crossAgent = await api('POST', `/api/agents/agent-does-not-exist/schedules`, {
			action: 'toggle', id, enabled: true
		});
		expect(crossAgent.status).toBe(404);

		const del = await api('POST', `/api/agents/${agentId}/schedules`, {
			action: 'delete', id
		});
		expect(del.status).toBe(200);

		const after = await api('GET', `/api/agents/${agentId}/schedules`);
		const arrAfter = after.data as unknown as Array<Record<string, unknown>>;
		expect(arrAfter.find(s => s.id === id)).toBeFalsy();
	});


	it('should set tags on an agent (validation + persistence)', async () => {
		const set = await fetch(`${BASE}/api/agents/${agentId}/tags`, {
			method: 'PUT',
			headers: { 'Content-Type': 'application/json', 'Origin': BASE, 'Cookie': cookieHeader() },
			body: JSON.stringify({ tags: ['prod', 'web', 'us-east'] })
		});
		expect(set.status).toBe(200);
		const body = await set.json() as { tags: string[] };
		expect(body.tags.sort()).toEqual(['prod', 'us-east', 'web']);

		const bad = await fetch(`${BASE}/api/agents/${agentId}/tags`, {
			method: 'PUT',
			headers: { 'Content-Type': 'application/json', 'Origin': BASE, 'Cookie': cookieHeader() },
			body: JSON.stringify({ tags: ['Prod'] })
		});
		expect(bad.status).toBe(400);
	});

	it('should bulk-dispatch by tag (matches resolved agent set)', async () => {
		const res = await api('POST', '/api/agents/dispatch', {
			tagAny: ['prod'],
			type: 'shell',
			payload: { command: 'uptime' },
			timeoutSeconds: 60
		});
		expect(res.status).toBe(200);
		const arr = res.data.dispatched as unknown as Array<Record<string, unknown>>;
		expect(arr.length).toBeGreaterThan(0);
		expect(arr[0].agentId).toBe(agentId);
	});

	it('should refuse bulk-dispatch with no targets', async () => {
		const res = await api('POST', '/api/agents/dispatch', {
			tagAny: [], tagAll: [],
			type: 'shell',
			payload: { command: 'uptime' }
		});
		expect(res.status).toBe(400);
	});

	it('should 404 bulk-dispatch when no agent matches', async () => {
		const res = await api('POST', '/api/agents/dispatch', {
			tagAny: ['no-such-tag-xyz'],
			type: 'shell',
			payload: { command: 'uptime' }
		});
		expect(res.status).toBe(404);
	});


	it('should dispatch reboot with delay + message', async () => {
		const res = await api('POST', `/api/agents/${agentId}/commands`, {
			type: 'reboot',
			payload: { delaySeconds: 600, message: 'Patching window' },
			timeoutSeconds: 60
		});
		expect(res.status).toBe(201);
		expect(res.data.type).toBe('reboot');
	});

	it('should reject reboot with delaySeconds > 24h', async () => {
		const res = await api('POST', `/api/agents/${agentId}/commands`, {
			type: 'reboot',
			payload: { delaySeconds: 90000 },
			timeoutSeconds: 60
		});
		expect(res.status).toBe(400);
	});


	it('should emit warning events for package install/remove between snapshots', async () => {
		await agentApi('POST', '/api/rmm/checkin', {
			packages: [
				{ manager: 'apt', name: 'curl', version: '7.81.0', latestVersion: '', updateAvailable: false }
			]
		}, agentBearerToken);

		await agentApi('POST', '/api/rmm/checkin', {
			packages: [
				{ manager: 'apt', name: 'wget', version: '1.21.2', latestVersion: '', updateAvailable: false }
			]
		}, agentBearerToken);

		const ev = await api('GET', `/api/agents/${agentId}/events?limit=50`);
		const arr = ev.data as unknown as Array<{ source: string; message: string }>;
		const installed = arr.find(e => e.source === 'package_change:apt' && e.message.includes('installed wget'));
		const removed = arr.find(e => e.source === 'package_change:apt' && e.message.includes('removed curl'));
		expect(installed).toBeTruthy();
		expect(removed).toBeTruthy();
	});


	it('should create + list + update + delete alert rules', async () => {
		const created = await api('POST', '/api/alert-rules', {
			name: 'High CPU prod',
			condition: { kind: 'metric_threshold', metric: 'cpu', op: '>', value: 90, tagAny: ['prod'] },
			cooldownMinutes: 30,
			channels: ['telegram']
		});
		expect(created.status).toBe(201);
		expect(created.data.name).toBe('High CPU prod');
		const ruleId = created.data.id as string;

		const list = await api('GET', '/api/alert-rules');
		const arr = list.data as unknown as Array<Record<string, unknown>>;
		expect(arr.find(r => r.id === ruleId)).toBeTruthy();

		const upd = await api('POST', '/api/alert-rules', {
			action: 'update', id: ruleId, enabled: false
		});
		expect(upd.status).toBe(200);
		expect(upd.data.enabled).toBe(false);

		const del = await api('POST', '/api/alert-rules', { action: 'delete', id: ruleId });
		expect(del.status).toBe(200);
	});

	it('should reject alert rule with malformed condition', async () => {
		const res = await api('POST', '/api/alert-rules', {
			name: 'broken',
			condition: { kind: 'unknown_kind' }
		});
		expect(res.status).toBe(400);
	});


	it('should refuse to issue a remote-session token when remoteDesktop is disabled', async () => {
		const res = await api('POST', `/api/agents/${agentId}/remote-session`, {});
		expect(res.status).toBe(400);
	});

	it('should set + read + clear an agent remote-desktop profile (secrets masked on read)', async () => {
		const enable = await api('POST', '/api/settings', {
			section: 'remoteDesktop',
			data: {
				enabled: true,
				guacdHost: '127.0.0.1', guacdPort: 4822,
				proxyPort: 4823, recordingEnabled: false,
				maxSessionMinutes: 60, tokenTtlSeconds: 300
			}
		});
		expect(enable.status).toBeLessThan(300);

		const set = await api('POST', `/api/agents/${agentId}/remote-session`, {
			action: 'set-profile',
			profile: {
				protocol: 'rdp', host: '10.0.0.5', port: 3389,
				username: 'Administrator', password: 'P@ssw0rd',
				domain: 'corp.local', ignoreCert: true
			}
		});
		expect(set.status).toBe(200);

		// Read — password must NOT be returned in plaintext
		const read = await api('GET', `/api/agents/${agentId}/remote-session`);
		expect(read.status).toBe(200);
		const profile = read.data.profile as Record<string, unknown> | null;
		expect(profile).toBeTruthy();
		expect(profile!.protocol).toBe('rdp');
		expect(profile!.port).toBe(3389);
		expect(profile!.hasPassword).toBe(true);
		expect((profile as Record<string, unknown>).password).toBeUndefined();

		const clear = await api('POST', `/api/agents/${agentId}/remote-session`, { action: 'clear-profile' });
		expect(clear.status).toBe(200);
		const read2 = await api('GET', `/api/agents/${agentId}/remote-session`);
		expect(read2.data.profile).toBeNull();
	});

	it('should issue a one-time session token, reject reuse + expired', async () => {
		await api('POST', `/api/agents/${agentId}/remote-session`, {
			action: 'set-profile',
			profile: { protocol: 'vnc', host: '10.0.0.99', port: 5900, password: 'shh' }
		});

		const issued = await api('POST', `/api/agents/${agentId}/remote-session`, {});
		expect(issued.status).toBe(201);
		expect(typeof issued.data.popupUrl).toBe('string');
		const popupUrl = issued.data.popupUrl as string;
		expect(popupUrl).toMatch(/^\/remote-desktop\/[0-9a-f]{64}$/);

		const first = await fetch(`${BASE}${popupUrl}`, {
			headers: { 'Cookie': cookieHeader() }, redirect: 'manual'
		});
		expect(first.status).toBe(200);

		const second = await fetch(`${BASE}${popupUrl}`, {
			headers: { 'Cookie': cookieHeader() }, redirect: 'manual'
		});
		expect(second.status).toBe(409);

		const bogus = await fetch(`${BASE}/remote-desktop/${'a'.repeat(64)}`, {
			headers: { 'Cookie': cookieHeader() }, redirect: 'manual'
		});
		expect(bogus.status).toBe(404);
	}, 30000);

	it('should refuse to issue a token if no profile is configured', async () => {
		await api('POST', `/api/agents/${agentId}/remote-session`, { action: 'clear-profile' });
		const res = await api('POST', `/api/agents/${agentId}/remote-session`, {});
		expect(res.status).toBe(400);
	});

	it('should report guacd status (not installed in CI)', async () => {
		const res = await api('GET', '/api/remote-desktop/guacd');
		expect(res.status).toBe(200);
		expect(typeof res.data.installed).toBe('boolean');
		expect(typeof res.data.reachable).toBe('boolean');
	});

	it('should return 409 (not 500) when dispatching to a legacy agent without hmac_secret', async () => {
		// M1 regression: dispatchCommand throws LegacyEnrollmentError when an
		// agent row has an empty hmac_secret (pre-AAD-migration). Route must
		// catch and return 409 with the operator-actionable message — not
		// surface as a generic 500 via SvelteKit's handleError.
		const Database = (await import('better-sqlite3')).default;
		const sdb = new Database(TEST_DB);
		let original = '';
		try {
			const row = sdb
				.prepare('SELECT hmac_secret FROM agents WHERE id = ?')
				.get(agentId) as { hmac_secret: string } | undefined;
			if (!row) throw new Error('agent not found in server DB');
			original = row.hmac_secret;
			sdb.prepare("UPDATE agents SET hmac_secret = '', status = 'online' WHERE id = ?").run(agentId);

			const res = await api('POST', `/api/agents/${agentId}/commands`, {
				type: 'shell',
				payload: { command: 'echo hi' }
			});
			expect(res.status).toBe(409);
			expect(typeof res.data.message).toBe('string');
			expect((res.data.message as string).toLowerCase()).toContain('re-enroll');
		} finally {
			sdb.prepare('UPDATE agents SET hmac_secret = ? WHERE id = ?').run(original, agentId);
			sdb.close();
		}
	});

	it('should delete agent', async () => {
		const res = await api('POST', '/api/agents', {
			action: 'delete',
			id: agentId
		});
		expect(res.status).toBe(200);

		const detail = await api('GET', `/api/agents/${agentId}`);
		expect(detail.status).toBe(404);
	});
});
