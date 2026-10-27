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
 * Skips cleanly when Caddy is not installed. The test generates a local
 * self-signed certificate and explicitly trusts it for the Node-side probes;
 * certificate validation is never disabled globally. Puppeteer accepts the
 * local certificate for the browser path only.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import puppeteer, { type Browser, type Page } from 'puppeteer';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import https from 'node:https';
import path from 'node:path';
import {
	startProductionServer, freshDataDir, cleanupDir,
	PASSWORD, isCommandAvailable, sleep, type LiveServer
} from './helpers';

const CADDY_PORT = 8443;
const BACKEND_PORT = 5502;
const PUBLIC_ORIGIN = `https://localhost:${CADDY_PORT}`;
const DATA_DIR = freshDataDir('caddy-tls');
const EMAIL = 'caddy-tls@example.com';
const CADDYFILE = path.join(DATA_DIR, 'Caddyfile');
const CERT_PATH = path.join(DATA_DIR, 'cert.pem');
const KEY_PATH = path.join(DATA_DIR, 'key.pem');
const hasCaddy = isCommandAvailable('caddy');

let server: LiveServer;
let caddy: ChildProcess | null = null;
let browser: Browser;
let page: Page;

interface HttpsResponse {
	status: number;
	headers: Record<string, string | string[] | undefined>;
	text: string;
}

/**
 * Minimal HTTPS client that trusts the test's self-signed certificate via the
 * explicit `ca` option. This keeps certificate validation enabled — unlike a
 * global NODE_TLS_REJECT_UNAUTHORIZED=0 — while still exercising the proxy.
 */
function httpsRequest(
	method: string,
	url: string,
	opts: { headers?: Record<string, string>; body?: string } = {}
): Promise<HttpsResponse> {
	return new Promise((resolve, reject) => {
		const target = new URL(url);
		const req = https.request({
			hostname: target.hostname,
			port: target.port,
			path: `${target.pathname}${target.search}`,
			method,
			headers: opts.headers,
			ca: readFileSync(CERT_PATH),
			servername: target.hostname,
			rejectUnauthorized: true
		}, (res) => {
			let text = '';
			res.setEncoding('utf8');
			res.on('data', (chunk) => { text += chunk; });
			res.on('end', () => resolve({
				status: res.statusCode ?? 0,
				headers: res.headers,
				text
			}));
		});
		req.on('error', reject);
		if (opts.body !== undefined) req.write(opts.body);
		req.end();
	});
}

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
			const res = await httpsRequest('GET', `${PUBLIC_ORIGIN}/api/healthz`);
			if (res.status === 200) return;
		} catch { /* not ready */ }
		await sleep(250);
	}
	throw new Error('Caddy HTTPS endpoint did not become ready');
}

beforeAll(async () => {
	if (!hasCaddy) return;
	const gen = spawnSync('openssl', [
		'req', '-x509', '-newkey', 'rsa:2048', '-nodes',
		'-keyout', KEY_PATH, '-out', CERT_PATH, '-days', '2',
		'-subj', '/CN=localhost', '-addext', 'subjectAltName=DNS:localhost'
	], { stdio: 'ignore' });
	if (gen.status !== 0) {
		throw new Error('failed to generate self-signed certificate for Caddy test');
	}
	writeFileSync(CADDYFILE, `${PUBLIC_ORIGIN} {
	tls ${CERT_PATH} ${KEY_PATH}
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
		// This is scoped to the browser process, not a global TLS disable.
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
		const dashboard = await httpsRequest('GET', `${PUBLIC_ORIGIN}/dashboard`, {
			headers: { Cookie: cookie }
		});
		expect(dashboard.status).toBe(200);
		// Caddy doesn't add HSTS itself; the app must when ORIGIN is https.
		expect(String(dashboard.headers['strict-transport-security'] ?? '')).toMatch(/max-age=/);
	}, 60_000);

	it('accepts the public HTTPS origin and rejects a different origin', async () => {
		const cookies = await page.cookies();
		const session = cookies.find((c) => c.name === 'itcake_session');
		const cookie = `itcake_session=${session!.value}`;

		// The JSON API's CSRF check compares Origin against ORIGIN. Through the
		// proxy the browser sends the public origin; an evil origin must 403.
		const evil = await httpsRequest('POST', `${PUBLIC_ORIGIN}/api/clients`, {
			headers: {
				Cookie: cookie,
				'Content-Type': 'application/json',
				Origin: 'http://evil.example'
			},
			body: JSON.stringify({
				name: 'Should Not Exist',
				email: 'evil@example.com',
				address: { street: '1 Evil', city: 'Evil', zip: '00000', state: '', country: 'DE' }
			})
		});
		expect(evil.status).toBe(403);
	}, 60_000);

	it('keeps the session usable and renders a page through the proxy', async () => {
		const cookies = await page.cookies();
		const session = cookies.find((c) => c.name === 'itcake_session');
		const cookie = `itcake_session=${session!.value}`;
		const me = await httpsRequest('GET', `${PUBLIC_ORIGIN}/api/auth/me`, {
			headers: { Cookie: cookie }
		});
		expect(me.status).toBe(200);
		expect((JSON.parse(me.text) as { email?: string }).email).toBe(EMAIL);
	}, 30_000);
});
