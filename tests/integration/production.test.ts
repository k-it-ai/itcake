/**
 * Production-mode smoke tests.
 *
 * The lifecycle suite runs `vite dev`, where SvelteKit skips form CSRF checks
 * and cookies are non-Secure. Production has different CSRF/origin semantics,
 * a different cookie policy, and adapter-node (not Vite) builds request URLs.
 * This suite boots the real `build/index.js` artifact so deployment regressions
 * fail CI instead of only showing up on a customer's server.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { existsSync, mkdirSync, rmSync } from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';

const PORT = 5399;
const BASE = `http://127.0.0.1:${PORT}`;
const DATA_DIR = path.resolve('data-test-production');
const DB_PATH = path.join(DATA_DIR, 'production.db');
const BUILD = path.resolve('build/index.js');
const PASSWORD = 'Prodpassword123';
const EMAIL = 'prod@test.com';

let serverProcess: ReturnType<typeof spawn> | null = null;
let cookie = '';
const logLines: string[] = [];

function capture(chunk: Buffer) {
	for (const line of chunk.toString().split('\n')) {
		if (line.trim()) logLines.push(line);
	}
	if (logLines.length > 300) logLines.splice(0, logLines.length - 300);
}

function cookieFrom(res: Response): string {
	const setCookies = res.headers.getSetCookie?.() ?? [];
	const session = setCookies.find(c => c.startsWith('itcake_session='));
	expect(session, 'response must set a session cookie').toBeTruthy();
	return session!.split(';')[0];
}

async function jsonCall(method: string, route: string, body?: unknown, opts: { origin?: string | null } = {}) {
	const headers: Record<string, string> = { Cookie: cookie };
	if (body !== undefined) headers['Content-Type'] = 'application/json';
	if (opts.origin !== null) headers.Origin = opts.origin ?? BASE;
	const res = await fetch(`${BASE}${route}`, {
		method,
		headers,
		body: body === undefined ? undefined : JSON.stringify(body),
		redirect: 'manual'
	});
	const text = await res.text();
	let data: Record<string, unknown> = {};
	try { data = JSON.parse(text); } catch { data = { raw: text }; }
	return { res, status: res.status, data };
}

async function waitForHealth(): Promise<void> {
	for (let i = 0; i < 40; i++) {
		try {
			const res = await fetch(`${BASE}/api/health`);
			if (res.ok) return;
		} catch { /* not ready */ }
		await new Promise(r => setTimeout(r, 250));
	}
	throw new Error(`production server did not become healthy:\n${logLines.join('\n')}`);
}

async function runStartupFailure(env: Record<string, string | undefined>, expected: RegExp): Promise<void> {
	const child = spawn(process.execPath, [BUILD], {
		cwd: process.cwd(),
		env: {
			...process.env,
			NODE_ENV: 'production',
			HOST: '127.0.0.1',
			PORT: String(PORT + 1),
			SESSION_SECRET: randomBytes(32).toString('hex'),
			FIELD_ENCRYPTION_KEY: randomBytes(32).toString('hex'),
			DATA_DIR: path.join(DATA_DIR, 'startup-failure'),
			DATABASE_PATH: path.join(DATA_DIR, 'startup-failure.db'),
			...env
		},
		stdio: ['ignore', 'pipe', 'pipe']
	});
	let output = '';
	child.stdout?.on('data', c => { output += c.toString(); });
	child.stderr?.on('data', c => { output += c.toString(); });

	const code = await new Promise<number | null>((resolve) => {
		const timer = setTimeout(() => { child.kill('SIGKILL'); resolve(null); }, 10_000);
		child.on('exit', (exitCode) => { clearTimeout(timer); resolve(exitCode); });
	});
	expect(code, `server should exit on invalid startup env:\n${output}`).not.toBe(0);
	expect(output).toMatch(expected);
}

beforeAll(async () => {
	if (!existsSync(BUILD)) {
		throw new Error('build/index.js is missing — run `npm run build` before the production integration suite');
	}
	if (existsSync(DATA_DIR)) rmSync(DATA_DIR, { recursive: true, force: true });
	mkdirSync(DATA_DIR, { recursive: true });

	// PUPPETEER_NO_SANDBOX is set for the dev lifecycle suite on CI. Production
	// deliberately refuses to start with it, so drop it here and let Chromium
	// use its sandbox (the production contract).
	const env = { ...process.env };
	delete env.PUPPETEER_NO_SANDBOX;

	serverProcess = spawn(process.execPath, [BUILD], {
		cwd: process.cwd(),
		env: {
			...env,
			NODE_ENV: 'production',
			HOST: '127.0.0.1',
			PORT: String(PORT),
			ORIGIN: BASE,
			SESSION_SECRET: randomBytes(32).toString('hex'),
			FIELD_ENCRYPTION_KEY: randomBytes(32).toString('hex'),
			// The production cookie is Secure by default now; this loopback HTTP
			// smoke test explicitly opts out so it can still exercise login.
			ALLOW_INSECURE_COOKIES: 'true',
			DATA_DIR,
			DATABASE_PATH: DB_PATH
		},
		stdio: ['ignore', 'pipe', 'pipe']
	});
	serverProcess.stdout?.on('data', capture);
	serverProcess.stderr?.on('data', capture);
	await waitForHealth();
}, 60_000);

afterAll(() => {
	serverProcess?.kill();
	serverProcess = null;
	if (existsSync(DATA_DIR)) rmSync(DATA_DIR, { recursive: true, force: true });
});

describe('production build', () => {
	it('boots with a runtime ORIGIN and reports readiness', async () => {
		const res = await fetch(`${BASE}/api/healthz`);
		expect(res.status).toBe(200);
		const body = (await res.json()) as { status?: string };
		expect(body.status).toBe('ok');
	});

	it('completes first-run setup and sets a non-Secure loopback cookie', async () => {
		const res = await fetch(`${BASE}/setup`, {
			method: 'POST',
			headers: { Origin: BASE, 'Content-Type': 'application/x-www-form-urlencoded' },
			body: new URLSearchParams({
				name: 'Prod User',
				email: EMAIL,
				password: PASSWORD,
				companyName: 'Prod Corp',
				language: 'en',
				currency: 'EUR'
			}),
			redirect: 'manual'
		});
		const text = await res.text();
		expect(res.status).toBe(200);
		expect(text).toContain('"type":"redirect"');
		expect(text).toContain('/dashboard');

		const setCookie = (res.headers.getSetCookie?.() ?? []).find(c => c.startsWith('itcake_session='));
		expect(setCookie).toBeTruthy();
		expect(setCookie).not.toMatch(/;\s*Secure/i);
		cookie = cookieFrom(res);
	});

	it('logs in through the JSON API and can load an authenticated page', async () => {
		const login = await jsonCall('POST', '/api/auth/login', { email: EMAIL, password: PASSWORD });
		expect(login.status).toBe(200);
		expect(login.data.email).toBe(EMAIL);
		const session = (login.res.headers.getSetCookie?.() ?? []).find(c => c.startsWith('itcake_session='));
		expect(session).toBeTruthy();
		cookie = session!.split(';')[0];

		const dashboard = await fetch(`${BASE}/dashboard`, { headers: { Cookie: cookie } });
		expect(dashboard.status).toBe(200);
		expect(await dashboard.text()).toContain('Prod User');
	});

	it('rejects cross-origin and origin-less mutating requests', async () => {
		const cross = await jsonCall('POST', '/api/auth/login', { email: EMAIL, password: PASSWORD }, { origin: 'http://evil.example' });
		expect(cross.status).toBe(403);
		const missing = await jsonCall('POST', '/api/auth/login', { email: EMAIL, password: PASSWORD }, { origin: null });
		expect(missing.status).toBe(403);
	});

	it('creates a client and invoice, then renders a real PDF', async () => {
		const client = await jsonCall('POST', '/api/clients', {
			name: 'Acme GmbH', email: 'client@test.com',
			address: { street: '1 Test St', city: 'Berlin', zip: '10115', state: '', country: 'DE' },
			phone: '+49 30 12345', website: 'https://acme.de', vatNumber: 'DE123456789',
			contactPerson: 'Max Mustermann', language: 'en', currency: 'EUR', paymentTermDays: 14
		});
		expect(client.status).toBe(201);
		expect(client.data.clientNumber).toBe('C-001');

		const today = new Date().toISOString().split('T')[0];
		const due = new Date(Date.now() + 30 * 86400000).toISOString().split('T')[0];
		const invoice = await jsonCall('POST', '/api/invoices', {
			clientId: client.data.id, pricingMode: 'net', currency: 'EUR', language: 'en',
			issueDate: today, dueDate: due,
			items: [{ id: 'p1', name: 'Production audit', description: 'E2E test', quantity: 1, unit: 'pc', unitPrice: 12500, taxRate: 19, items: [] }],
			discounts: [], notes: 'Production smoke test', footerText: '', templateId: 'itcake', templateOptions: {}
		});
		expect(invoice.status).toBe(201);
		expect(invoice.data.documentId).toMatch(new RegExp(`^${new Date().getFullYear()}-\\d{4}$`));

		const pdf = await fetch(`${BASE}/api/invoices/${invoice.data.id}/pdf`, { headers: { Cookie: cookie } });
		expect(pdf.status).toBe(200);
		expect(pdf.headers.get('content-type')).toContain('application/pdf');
		const buffer = await pdf.arrayBuffer();
		expect(String.fromCharCode(...new Uint8Array(buffer.slice(0, 5)))).toBe('%PDF-');
	}, 60_000);

	it('creates, previews, and restores a backup', async () => {
		const create = await jsonCall('POST', '/api/backups', { action: 'create' });
		expect(create.status).toBeLessThan(300);
		const filename = create.data.filename as string;
		expect(filename).toMatch(/^backup-/);

		const preview = await jsonCall('POST', '/api/backups', { action: 'restore_preview', filename });
		expect(preview.status).toBeLessThan(300);
		expect(preview.data.backupTimestamp).toBeTruthy();

		const restore = await jsonCall('POST', '/api/backups', { action: 'restore', filename, password: PASSWORD });
		expect(restore.status).toBeLessThan(300);

		const login = await jsonCall('POST', '/api/auth/login', { email: EMAIL, password: PASSWORD });
		expect(login.status).toBe(200);
		cookie = (login.res.headers.getSetCookie?.() ?? []).find(c => c.startsWith('itcake_session='))!.split(';')[0];
	}, 30_000);

	it('enrolls an agent and accepts a bearer-authenticated check-in without CSRF headers', async () => {
		const tokenRes = await jsonCall('POST', '/api/agents/enrollment-tokens', { name: 'prod-agent' });
		expect(tokenRes.status).toBe(201);

		const enroll = await fetch(`${BASE}/api/rmm/enroll`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({
				token: tokenRes.data.token,
				hostname: 'prod-agent-host',
				os: 'linux',
				arch: 'amd64',
				osVersion: 'Ubuntu 22.04',
				agentVersion: '0.1.0',
				hmacSecret: '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef'
			})
		});
		expect(enroll.status).toBe(201);
		const enrolled = (await enroll.json()) as { token: string; agentId: string };

		const checkin = await fetch(`${BASE}/api/rmm/checkin`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${enrolled.token}` },
			body: JSON.stringify({
				hostname: 'prod-agent-host',
				metrics: { cpuPercent: 12, memoryUsedBytes: 1024, memoryTotalBytes: 2048, diskUsedBytes: 100, diskTotalBytes: 1000, loadAvg1: 0.1, loadAvg5: 0.1, loadAvg15: 0.1, uptimeSeconds: 120 }
			})
		});
		expect(checkin.status).toBe(200);

		const agents = await jsonCall('GET', '/api/agents');
		expect(agents.status).toBe(200);
		expect((agents.data as unknown as Array<Record<string, unknown>>).some(a => a.id === enrolled.agentId)).toBe(true);
	}, 30_000);

	it('refuses to start without ORIGIN', async () => {
		await runStartupFailure({ ORIGIN: undefined }, /ORIGIN is required in production/);
	});

	it('refuses to start with a trailing-slash ORIGIN', async () => {
		await runStartupFailure({ ORIGIN: `${BASE}/` }, /trailing slash/i);
	});

	it('refuses to start with non-loopback http ORIGIN', async () => {
		await runStartupFailure({ ORIGIN: 'http://invoices.example.com' }, /Production requires HTTPS/);
	});
});
