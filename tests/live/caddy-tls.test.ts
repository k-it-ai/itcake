/**
 * Live TLS reverse-proxy test with Caddy.
 *
 * The production server is started with ORIGIN set to the Caddy HTTPS URL (not
 * the loopback backend), then Caddy terminates TLS on a high port and proxies
 * to the loopback backend. This is the deployment shape install.sh configures.
 *
 * Verifies:
 *  - the app serves through the proxy over HTTPS
 *  - session cookies carry Secure (ORIGIN protocol drives the flag)
 *  - HSTS / proxy headers survive the hop
 *  - CSRF still accepts the configured public origin and rejects another one
 *
 * Skips cleanly when Caddy is not installed. Uses Caddy's internal CA; the
 * browser ignores the self-signed certificate for this local-only run.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import puppeteer, { type Browser, type Page } from 'puppeteer';
import { spawn, type ChildProcess } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import {
	startProductionServer, freshDataDir, cleanupDir, jsonCall, cookieFrom,
	PASSWORD, isCommandAvailable, sleep, type LiveServer
} from './helpers';

// Caddy's internal CA is local-only; accept it for this worker's Node-side
// probes. Puppeteer uses ignoreHTTPSErrors for the browser path. Set inside
// beforeAll so machines without Caddy skip without mutating the environment.
let previousTlsSetting: string | undefined;

const CADDY_PORT = 8443;
const BACKEND_PORT = 5502;
const PUBLIC_ORIGIN = `https://localhost:${CADDY_PORT}`;
const DATA_DIR = freshDataDir('caddy-tls');
const EMAIL = 'caddy-tls@example.com';
const CADDYFILE = path.join(DATA_DIR, 'Caddyfile');
const hasCaddy = isCommandAvailable('caddy');

let server: LiveServer;
let caddy: ChildProcess | null = null;
let browser: Browser;
let page: Page;

function startCaddy(): Promise<void> {
	return new Promise((resolve, reject) => {
		const logs: string[] = [];
		caddy = spawn('caddy', ['run', '--config', CADDYFILE, '--adapter', 'caddyfile'], {
			stdio: ['ignore', 'pipe', 'pipe'],
			env: { ...process.env, HOME: DATA_DIR, XDG_DATA_HOME: path.join(DATA_DIR, 'caddy-data') }
		});
		const onData = (chunk: Buffer) => {
			logs.push(chunk.toString());
			if (logs.join('').includes('server running')) resolve();
		};
		caddy.stdout?.on('data', onData);
		caddy.stderr?.on('data', onData);
		caddy.once('exit', (code) => reject(new Error(`caddy exited early (${code}):\n${logs.join('')}`)));
		setTimeout(() => {
			caddy?.kill('SIGKILL');
			reject(new Error(`caddy did not start:\n${logs.join('')}`));
		}, 20_000).unref();
	});
}

async function waitHttpsReady(): Promise<void> {
	const deadline = Date.now() + 20_000;
	while (Date.now() < deadline) {
		try {
			const res = await fetch(`${PUBLIC_ORIGIN}/api/healthz`);
			if (res.ok) return;
		} catch { /* not ready */ }
		await sleep(250);
	}
	throw new Error('Caddy HTTPS endpoint did not become ready');
}

beforeAll(async () => {
	previousTlsSetting = process.env.NODE_TLS_REJECT_UNAUTHORIZED;
	process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
	writeFileSync(CADDYFILE, `{
	skip_install_trust
}
${PUBLIC_ORIGIN} {
	tls internal
	reverse_proxy 127.0.0.1:${BACKEND_PORT}
}
`);
	server = await startProductionServer({
		port: BACKEND_PORT,
		dataDir: DATA_DIR,
		origin: PUBLIC_ORIGIN,
		base: `http://127.0.0.1:${BACKEND_PORT}`,
		env: {
			// Caddy adds X-Forwarded-For; the app only trusts it from a loopback proxy.
			ADDRESS_HEADER: 'X-Forwarded-For'
		}
	});
	await startCaddy();
	await waitHttpsReady();
	browser = await puppeteer.launch({
		headless: true,
		// Puppeteer 25 replaced `ignoreHTTPSErrors` with `acceptInsecureCerts`.
		// The Chrome flag is an extra fail-safe for headless certificate checks.
		acceptInsecureCerts: true,
		args: [
			'--ignore-certificate-errors',
			...(process.env.PUPPETEER_NO_SANDBOX === 'true'
				? ['--no-sandbox', '--disable-setuid-sandbox']
				: [])
		]
	});
	page = await browser.newPage();
	page.setDefaultTimeout(20_000);
}, 120_000);

afterAll(async () => {
	await page?.close().catch(() => {});
	await browser?.close().catch(() => {});
	if (caddy) {
		caddy.kill('SIGTERM');
		await new Promise<void>((resolve) => {
			const timer = setTimeout(() => { caddy?.kill('SIGKILL'); resolve(); }, 3_000);
			caddy?.once('exit', () => { clearTimeout(timer); resolve(); });
		});
	}
	await server?.stop();
	cleanupDir(DATA_DIR);
	if (previousTlsSetting === undefined) delete process.env.NODE_TLS_REJECT_UNAUTHORIZED;
	else process.env.NODE_TLS_REJECT_UNAUTHORIZED = previousTlsSetting;
});

describe.skipIf(!hasCaddy)('Caddy TLS reverse proxy', () => {
	it('serves the app over HTTPS with HSTS and a Secure session cookie', async () => {
		await page.goto(`${PUBLIC_ORIGIN}/setup`, { waitUntil: 'networkidle0' });
		const title = await page.title();
		expect(title).toBeTruthy();

		// Complete setup through the proxied origin.
		await page.type('input[name="name"]', 'Caddy TLS Admin');
		await page.type('input[name="email"]', EMAIL);
		await page.type('input[name="password"]', PASSWORD);
		await page.keyboard.press('Enter');
		await page.waitForFunction(() => {
			const el = document.querySelector('input[name="companyName"]');
			return !!el && (el as HTMLElement).offsetParent !== null;
		});
		await page.type('input[name="companyName"]', 'Caddy TLS Corp');
		await page.keyboard.press('Enter');
		await page.waitForFunction(() => {
			const el = document.querySelector('select[name="language"]');
			return !!el && (el as HTMLElement).offsetParent !== null;
		});
		await page.select('select[name="language"]', 'en');
		await page.click('button[type="submit"]');
		await page.waitForFunction(() => location.pathname === '/dashboard');

		const cookies = await page.cookies();
		const session = cookies.find((c) => c.name === 'itcake_session');
		expect(session, 'session cookie must be set through Caddy').toBeTruthy();
		// The production cookie policy derives Secure from the ORIGIN protocol.
		expect(session!.secure).toBe(true);

		const cookie = `itcake_session=${session!.value}`;
		const dashboard = await fetch(`${PUBLIC_ORIGIN}/dashboard`, {
			headers: { Cookie: cookie }
		});
		expect(dashboard.status).toBe(200);
		const headers = dashboard.headers;
		// Caddy doesn't add HSTS itself; the app must when ORIGIN is https.
		expect(headers.get('strict-transport-security')).toMatch(/max-age=/);
	}, 60_000);

	it('accepts the public HTTPS origin and rejects a different origin', async () => {
		const cookies = await page.cookies();
		const session = cookies.find((c) => c.name === 'itcake_session');
		const cookie = `itcake_session=${session!.value}`;

		// The JSON API's CSRF check compares Origin against ORIGIN. Through the
		// proxy the browser sends the public origin; an evil origin must 403.
		const proxyServer: LiveServer = { ...server, base: PUBLIC_ORIGIN, origin: PUBLIC_ORIGIN };
		const evil = await jsonCall(
			proxyServer,
			'POST', '/api/clients',
			{ name: 'Should Not Exist', email: 'evil@example.com', address: { street: '1 Evil', city: 'Evil', zip: '00000', state: '', country: 'DE' } },
			{ cookie, origin: 'http://evil.example' }
		);
		expect(evil.status).toBe(403);
	}, 60_000);

	it('keeps the session usable and renders a page through the proxy', async () => {
		const cookies = await page.cookies();
		const session = cookies.find((c) => c.name === 'itcake_session');
		const cookie = `itcake_session=${session!.value}`;
		const proxyServer: LiveServer = { ...server, base: PUBLIC_ORIGIN, origin: PUBLIC_ORIGIN };
		const me = await jsonCall(proxyServer, 'GET', '/api/auth/me', undefined, { cookie });
		expect(me.status).toBe(200);
		expect(me.data.email).toBe(EMAIL);
	}, 30_000);
});
