import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execSync } from 'node:child_process';
import { existsSync, mkdirSync, rmSync } from 'node:fs';
import path from 'node:path';

const TEST_PORT = 5298;
const BASE = `http://localhost:${TEST_PORT}`;
const TEST_DATA_DIR = path.resolve('data-test-integration');
const TEST_DB = path.join(TEST_DATA_DIR, 'test.db');
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

beforeAll(async () => {
	if (existsSync(TEST_DATA_DIR)) rmSync(TEST_DATA_DIR, { recursive: true });
	mkdirSync(TEST_DATA_DIR, { recursive: true });
	mkdirSync(path.join(TEST_DATA_DIR, 'uploads'), { recursive: true });
	mkdirSync(path.join(TEST_DATA_DIR, 'backups'), { recursive: true });

	const { spawn } = await import('node:child_process');
	serverProcess = spawn('node_modules/.bin/vite', ['dev', '--port', String(TEST_PORT)], {
		env: {
			...process.env,
			DATABASE_PATH: TEST_DB,
			DATA_DIR: TEST_DATA_DIR,
			PORT: String(TEST_PORT),
			HOST: '127.0.0.1'
		},
		stdio: 'pipe'
	});

	// Wait for server to be ready
	for (let i = 0; i < 30; i++) {
		try {
			const res = await fetch(`${BASE}/api/health`);
			if (res.ok) break;
		} catch { /* not ready */ }
		await new Promise(r => setTimeout(r, 1000));
	}
}, 60000);

afterAll(() => {
	serverProcess?.kill();
	if (existsSync(TEST_DATA_DIR)) rmSync(TEST_DATA_DIR, { recursive: true });
});

describe('lifecycle', () => {
	it('setup → login → CRUD → status transitions → backup', async () => {
		// Setup wizard
		const setupRes = await fetch(`${BASE}/setup`, {
			method: 'POST',
			headers: { 'Origin': BASE, 'Content-Type': 'application/x-www-form-urlencoded' },
			body: 'name=Test+User&email=test%40test.com&password=testpassword123&companyName=Test+Corp&language=en&currency=EUR',
			redirect: 'manual'
		});
		extractCookies(setupRes);
		expect(setupRes.status).toBeLessThan(400);

		// Auth check
		const me = await api('GET', '/api/auth/me');
		expect(me.data.email).toBe('test@test.com');

		// Setup re-trigger protection
		const reSetup = await fetch(`${BASE}/setup`, { redirect: 'manual' });
		expect(reSetup.status).toBe(302);

		// Create client
		const client = await api('POST', '/api/clients', {
			name: 'Integration Client', email: 'client@test.com',
			address: { street: '1 Test St', city: 'Berlin', zip: '10115', state: '', country: 'DE' }
		});
		expect(client.status).toBeLessThan(300);
		expect(client.data.clientNumber).toBe('C-001');
		const clientId = client.data.id as string;

		// Create invoice
		const today = new Date().toISOString().split('T')[0];
		const due = new Date(Date.now() + 30 * 86400000).toISOString().split('T')[0];
		const invoice = await api('POST', '/api/invoices', {
			clientId, pricingMode: 'net', currency: 'EUR', language: 'en',
			issueDate: today, dueDate: due,
			items: [{ id: 'i1', name: 'Dev', description: '', quantity: 10, unit: 'hrs', unitPrice: 10000, taxRate: 19, items: [] }],
			discounts: [], notes: '', footerText: '', templateId: 'plain', templateOptions: {}
		});
		expect(invoice.status).toBeLessThan(300);
		expect(invoice.data.documentId).toBe('2026-0001');
		expect((invoice.data.totals as Record<string, number>).total).toBe(119000); // 100000 + 19000
		const invId = invoice.data.id as string;

		// Edit invoice
		const updated = await api('POST', '/api/invoices', { action: 'update', id: invId, notes: 'Updated' });
		expect(updated.data.notes).toBe('Updated');

		// Preview HTML
		const preview = await fetch(`${BASE}/api/invoices/${invId}/preview`, {
			headers: { Cookie: cookieHeader() }
		});
		expect(preview.status).toBe(200);
		expect(preview.headers.get('content-type')).toContain('text/html');

		// PDF
		const pdf = await fetch(`${BASE}/api/invoices/${invId}/pdf`, {
			headers: { Cookie: cookieHeader() }
		});
		expect(pdf.status).toBe(200);
		expect(pdf.headers.get('content-type')).toContain('application/pdf');

		// Status: draft → sent
		const sent = await api('POST', `/api/invoices/${invId}/status`, { status: 'sent' });
		expect(sent.data.status).toBe('sent');

		// Status: sent → paid
		const paid = await api('POST', `/api/invoices/${invId}/status`, { status: 'paid' });
		expect(paid.data.status).toBe('paid');

		// Invalid transition: paid → draft (should fail)
		const invalid = await api('POST', `/api/invoices/${invId}/status`, { status: 'draft' });
		expect(invalid.status).toBe(400);

		// Create proposal
		const proposal = await api('POST', '/api/proposals', {
			clientId, pricingMode: 'net', currency: 'EUR', language: 'en',
			issueDate: today, validUntil: due,
			items: [{ id: 'p1', name: 'Design', description: '', quantity: 1, unit: 'project', unitPrice: 250000, taxRate: 19, items: [] }],
			discounts: [], introText: '', notes: '', footerText: '', templateId: 'plain', templateOptions: {}
		});
		expect(proposal.status).toBeLessThan(300);
		const propId = proposal.data.id as string;

		// Proposal status changes use form actions — verify proposal was created as draft
		expect(proposal.data.status).toBe('draft');

		// Create monitor
		const monitor = await api('POST', '/api/monitors', {
			name: 'Test Monitor', ip: '8.8.8.8', domain: '',
			enabled: true, checks: { ping: true, http: false, domainExpiry: false, sslExpiry: false },
			httpExpectedStatus: 200, domainExpiryThresholdDays: 30, sslExpiryThresholdDays: 14
		});
		expect(monitor.status).toBeLessThan(300);

		// Backup
		const backup = await api('POST', '/api/backups', { action: 'create' });
		expect(backup.status).toBeLessThan(300);
		expect(backup.data.filename).toMatch(/^backup-/);

		// Client delete blocked (has linked invoices)
		const delClient = await api('POST', '/api/clients', { action: 'delete', id: clientId });
		expect(delClient.status).toBe(400);
	}, 120000);
});
