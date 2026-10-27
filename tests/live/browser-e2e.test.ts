/**
 * Live browser E2E: setup → MFA enable → MFA login → client → invoice.
 *
 * Runs against the real production artifact with a throwaway data directory.
 * Puppeteer drives the actual SvelteKit forms (not API shortcuts) so client-side
 * form enhancement, CSRF origin checks, and cookie handling are exercised the
 * way a browser exercises them. The session cookie is then reused for API
 * assertions (PDF, CSRF rejection) without weakening the browser path.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import puppeteer, { type Browser, type Page } from 'puppeteer';
import {
	startProductionServer, freshDataDir, cleanupDir, jsonCall, cookieFrom,
	PASSWORD, totpCode, sleep, type LiveServer
} from './helpers';

const DATA_DIR = freshDataDir('browser-e2e');
const EMAIL = 'browser-e2e@example.com';
const CLIENT_NAME = 'E2E Browser Client GmbH';
const PORT = 5501;
const BASE = `http://127.0.0.1:${PORT}`;

let server: LiveServer;
let browser: Browser;
let page: Page;
let sessionCookie = '';
let mfaSecret = '';
let lastLoginCode = '';

async function waitVisible(selector: string, timeout = 10_000): Promise<void> {
	await page.waitForFunction(
		(sel) => {
			const el = document.querySelector(sel);
			return !!el && (el as HTMLElement).offsetParent !== null;
		},
		{ timeout },
		selector
	);
}

async function clickButtonByText(text: string): Promise<void> {
	const clicked = await page.evaluate((needle) => {
		const buttons = Array.from(document.querySelectorAll('button'));
		const target = buttons.find((b) => (b.textContent ?? '').trim().includes(needle));
		if (!target) return false;
		(target as HTMLButtonElement).click();
		return true;
	}, text);
	if (!clicked) throw new Error(`button containing "${text}" not found`);
}

async function cookieHeaderFromPage(): Promise<string> {
	const cookies = await page.cookies();
	const session = cookies.find((c) => c.name === 'itcake_session');
	if (!session) throw new Error('browser session cookie not found');
	return `itcake_session=${session.value}`;
}

beforeAll(async () => {
	server = await startProductionServer({ port: PORT, dataDir: DATA_DIR, origin: BASE });
	browser = await puppeteer.launch({
		headless: true,
		args: process.env.PUPPETEER_NO_SANDBOX === 'true'
			? ['--no-sandbox', '--disable-setuid-sandbox']
			: []
	});
	page = await browser.newPage();
	page.setDefaultTimeout(15_000);
}, 120_000);

afterAll(async () => {
	await page?.close().catch(() => {});
	await browser?.close().catch(() => {});
	await server?.stop();
	cleanupDir(DATA_DIR);
});

describe('browser E2E against the production build', () => {
	it('completes first-run setup through the real multi-step form', async () => {
		await page.goto(`${BASE}/setup`, { waitUntil: 'networkidle0' });
		expect(await page.title()).toBeTruthy();

		await page.type('input[name="name"]', 'Browser E2E Admin');
		await page.type('input[name="email"]', EMAIL);
		await page.type('input[name="password"]', PASSWORD);
		// Enter advances to step 2 without submitting the form.
		await page.keyboard.press('Enter');

		await waitVisible('input[name="companyName"]');
		await page.type('input[name="companyName"]', 'Browser E2E Corp');
		await page.type('input[name="companyEmail"]', 'billing@browser-e2e.example');
		await page.select('select[name="companyCountry"]', 'DE');
		await page.keyboard.press('Enter');

		await waitVisible('select[name="language"]');
		await page.select('select[name="language"]', 'en');
		await page.select('select[name="currency"]', 'EUR');
		// The setup page's own UI language is still the default (de) until the
		// first submit, so target the submit button structurally.
		await page.click('button[type="submit"]');
		await page.waitForFunction(() => location.pathname === '/dashboard');
		sessionCookie = await cookieHeaderFromPage();
		expect(sessionCookie).toMatch(/^itcake_session=/);
	}, 60_000);

	it('enables MFA through the authenticated API and revokes the old session', async () => {
		const init = await jsonCall(server, 'POST', '/api/auth/mfa', {
			action: 'init', currentPassword: PASSWORD
		}, { cookie: sessionCookie });
		expect(init.status).toBe(200);
		expect(init.data.secret).toMatch(/^[A-Z2-7]+=*$/);
		expect(Array.isArray(init.data.recoveryCodes)).toBe(true);
		mfaSecret = init.data.secret as string;

		const enable = await jsonCall(server, 'POST', '/api/auth/mfa', {
			action: 'enable',
			currentPassword: PASSWORD,
			secret: mfaSecret,
			code: totpCode(mfaSecret),
			recoveryCodes: init.data.recoveryCodes
		}, { cookie: sessionCookie });
		expect(enable.status).toBe(200);
		expect(enable.data.sessionRevoked).toBe(true);

		// The revoked cookie must no longer authenticate.
		const me = await jsonCall(server, 'GET', '/api/auth/me', undefined, { cookie: sessionCookie });
		expect(me.status).toBe(401);
	}, 60_000);

	it('logs in through the browser with password + TOTP', async () => {
		await page.goto(`${BASE}/login`, { waitUntil: 'networkidle0' });
		await page.type('input[name="email"]', EMAIL);
		await page.type('input[name="password"]', PASSWORD);
		await clickButtonByText('Sign in');

		await waitVisible('input[name="mfaCode"]');
		lastLoginCode = totpCode(mfaSecret);
		await page.type('input[name="password"]', PASSWORD);
		await page.type('input[name="mfaCode"]', lastLoginCode);
		await clickButtonByText('Verify');
		await page.waitForFunction(() => location.pathname === '/dashboard');
		sessionCookie = await cookieHeaderFromPage();
	}, 60_000);

	it('rejects a replayed TOTP code and a cross-origin mutating request', async () => {
		// Replay: a fresh password step returns a new challenge; the same TOTP
		// step value was already consumed by the previous login.
		const step1 = await jsonCall(server, 'POST', '/api/auth/login', { email: EMAIL, password: PASSWORD });
		expect(step1.status).toBe(200);
		expect(step1.data.mfaRequired).toBe(true);
		const token = step1.data.mfaToken as string;

		const replay = await jsonCall(server, 'POST', '/api/auth/login', {
			email: EMAIL, password: PASSWORD, mfaCode: lastLoginCode, mfaToken: token
		});
		// The TOTP step value used by the successful browser login is consumed
		// server-side; reusing it must fail even with a fresh challenge token.
		expect(replay.status).toBe(401);

		const cross = await jsonCall(server, 'POST', '/api/clients', {
			name: 'Should Not Exist', email: 'cross@evil.example',
			address: { street: '1 Evil St', city: 'Evil', zip: '00000', state: '', country: 'DE' }
		}, { cookie: sessionCookie, origin: 'http://evil.example' });
		expect(cross.status).toBe(403);

		const missing = await jsonCall(server, 'POST', '/api/clients', {
			name: 'Should Not Exist', email: 'missing@evil.example',
			address: { street: '1 Evil St', city: 'Evil', zip: '00000', state: '', country: 'DE' }
		}, { cookie: sessionCookie, origin: null });
		expect(missing.status).toBe(403);
	}, 60_000);

	it('creates a client through the browser form', async () => {
		await page.goto(`${BASE}/clients/new`, { waitUntil: 'networkidle0' });
		await page.type('input[name="name"]', CLIENT_NAME);
		await page.type('input[name="email"]', 'client@browser-e2e.example');
		await page.type('input[name="street"]', '42 Browser Street');
		await page.type('input[name="city"]', 'Berlin');
		await page.type('input[name="zip"]', '10115');
		await page.select('select[name="country"]', 'DE');
		await clickButtonByText('Create Client');
		await page.waitForFunction(() => location.pathname === '/clients');

		const html = await page.content();
		expect(html).toContain(CLIENT_NAME);
	}, 60_000);

	it('creates an invoice through the browser form and renders a real PDF', async () => {
		const clients = await jsonCall(server, 'GET', '/api/clients', undefined, { cookie: sessionCookie });
		expect(clients.status).toBe(200);
		const list = clients.data as unknown as Array<Record<string, unknown>>;
		const client = list.find((c) => c.name === CLIENT_NAME);
		expect(client).toBeTruthy();
		const clientId = client!.id as string;

		await page.goto(`${BASE}/invoices/new?clientId=${encodeURIComponent(clientId)}`, { waitUntil: 'networkidle0' });
		// Wait for the prefilled client selection and add one line item.
		await page.waitForFunction(
			(id) => (document.querySelector('select[name="client"]') as HTMLSelectElement | null)?.value === id,
			{},
			clientId
		);
		await clickButtonByText('Add Item');

		// The editor opens the new row. Fill name and unit price in euros.
		await page.waitForSelector('input[placeholder="Item name"]');
		await page.type('input[placeholder="Item name"]', 'Browser E2E service');
		await page.$eval('input[name="price-0"]', (el) => {
			const input = el as HTMLInputElement;
			input.value = '125.00';
			input.dispatchEvent(new Event('input', { bubbles: true }));
		});

		// Svelte propagates the new line item to the parent binding asynchronously;
		// wait until the create button is enabled before clicking it.
		await page.waitForFunction(() => {
			const buttons = Array.from(document.querySelectorAll('button'));
			const target = buttons.find((b) => (b.textContent ?? '').trim().includes('Create Invoice'));
			return !!target && !(target as HTMLButtonElement).disabled;
		});
		await clickButtonByText('Create Invoice');
		try {
			await page.waitForFunction(
				() => location.pathname !== '/invoices/new' && /^\/invoices\/[^/]+$/.test(location.pathname),
				{ timeout: 20_000 }
			);
		} catch {
			const text = await page.evaluate(() => document.body.innerText);
			console.error('[browser-e2e] invoice creation did not navigate. Page text:\n', text.slice(0, 2000));
			throw new Error('invoice creation did not navigate');
		}
		const invoiceUrl = page.url();
		const invoiceId = invoiceUrl.split('/').pop()!;
		expect(invoiceId).not.toBe('new');
		expect(invoiceId).toBeTruthy();

		const html = await page.content();
		expect(html).toContain('Browser E2E service');

		const pdf = await fetch(`${BASE}/api/invoices/${invoiceId}/pdf`, { headers: { Cookie: sessionCookie } });
		expect(pdf.status).toBe(200);
		expect(pdf.headers.get('content-type')).toContain('application/pdf');
		const bytes = new Uint8Array(await pdf.arrayBuffer());
		expect(String.fromCharCode(...bytes.slice(0, 5))).toBe('%PDF-');
	}, 90_000);

	it('keeps the authenticated session usable after the E2E flow', async () => {
		const me = await jsonCall(server, 'GET', '/api/auth/me', undefined, { cookie: sessionCookie });
		expect(me.status).toBe(200);
		expect(me.data.email).toBe(EMAIL);
	}, 30_000);
});
