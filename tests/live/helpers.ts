/**
 * Shared helpers for the opt-in "live" integration suite.
 *
 * These tests boot the real production artifact (`build/index.js`) and drive
 * external surfaces (Chromium, Caddy, a real Go agent binary, Ethereal SMTP,
 * Telegram/Anthropic APIs). They are intentionally NOT part of `npm test` so a
 * plain CI run stays hermetic and fast. Run them with:
 *
 *   npm run test:live            # all live tests that can run here
 *   npx vitest run tests/live/browser-e2e.test.ts
 *
 * Tests that need credentials or binaries skip themselves with a clear reason
 * instead of failing the suite.
 */
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { existsSync, mkdirSync, rmSync } from 'node:fs';
import crypto, { randomBytes } from 'node:crypto';
import net from 'node:net';
import path from 'node:path';

export const ROOT = path.resolve('.');
export const BUILD = path.join(ROOT, 'build/index.js');
export const PASSWORD = 'LiveTestPassword123';

export function assertBuildExists(): void {
	if (!existsSync(BUILD)) {
		throw new Error('build/index.js is missing — run `npm run build` before the live suite');
	}
}

export function freshDataDir(name: string): string {
	const dir = path.resolve(`data-test-live-${name}`);
	if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
	mkdirSync(dir, { recursive: true });
	return dir;
}

export function cleanupDir(dir: string): void {
	if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
}

export interface LiveServerOptions {
	port: number;
	dataDir: string;
	origin?: string;
	/** Address used for the readiness probe when the public origin is a proxy. */
	base?: string;
	env?: Record<string, string | undefined>;
}

export interface LiveServer {
	base: string;
	origin: string;
	dataDir: string;
	process: ChildProcess;
	logs: string[];
	stop: () => Promise<void>;
}

export async function startProductionServer(opts: LiveServerOptions): Promise<LiveServer> {
	assertBuildExists();
	const origin = opts.origin ?? `http://127.0.0.1:${opts.port}`;
	const logs: string[] = [];
	// Production deliberately refuses PUPPETEER_NO_SANDBOX. The test process may
	// need it to launch its own Chromium on CI runners, but the server must not
	// inherit it.
	const env: NodeJS.ProcessEnv = { ...process.env };
	delete env.PUPPETEER_NO_SANDBOX;
	const child = spawn(process.execPath, [BUILD], {
		cwd: ROOT,
		env: {
			...env,
			NODE_ENV: 'production',
			HOST: '127.0.0.1',
			PORT: String(opts.port),
			ORIGIN: origin,
			SESSION_SECRET: randomBytes(32).toString('hex'),
			FIELD_ENCRYPTION_KEY: randomBytes(32).toString('hex'),
			// The production cookie is Secure when ORIGIN is https. The plain-HTTP
			// loopback tests opt out; the Caddy test uses the real https path.
			ALLOW_INSECURE_COOKIES: origin.startsWith('https') ? 'false' : 'true',
			DATA_DIR: opts.dataDir,
			DATABASE_PATH: path.join(opts.dataDir, 'itcake.db'),
			...opts.env
		},
		stdio: ['ignore', 'pipe', 'pipe']
	});

	const capture = (chunk: Buffer) => {
		for (const line of chunk.toString().split('\n')) {
			if (line.trim()) logs.push(line);
		}
		if (logs.length > 400) logs.splice(0, logs.length - 400);
	};
	child.stdout?.on('data', capture);
	child.stderr?.on('data', capture);

	const base = opts.base ?? origin;
	const deadline = Date.now() + 40_000;
	let healthy = false;
	while (Date.now() < deadline) {
		try {
			const res = await fetch(`${base}/api/healthz`);
			if (res.ok) { healthy = true; break; }
		} catch { /* not ready */ }
		await new Promise(r => setTimeout(r, 250));
	}
	if (!healthy) {
		child.kill('SIGKILL');
		throw new Error(`production server did not become healthy on ${base}:\n${logs.join('\n')}`);
	}

	return {
		base,
		origin,
		dataDir: opts.dataDir,
		process: child,
		logs,
		stop: async () => {
			if (child.exitCode === null && child.signalCode === null) {
				child.kill('SIGTERM');
				await new Promise<void>((resolve) => {
					const timer = setTimeout(() => { child.kill('SIGKILL'); resolve(); }, 5_000);
					child.once('exit', () => { clearTimeout(timer); resolve(); });
				});
			}
		}
	};
}

export interface Session {
	cookie: string;
}

export function cookieFrom(res: Response): string {
	const setCookies = res.headers.getSetCookie?.() ?? [];
	const session = setCookies.find(c => c.startsWith('itcake_session='));
	if (!session) throw new Error('response did not set a session cookie');
	return session.split(';')[0];
}

export function setCookieHeader(res: Response): string[] {
	return res.headers.getSetCookie?.() ?? [];
}

export async function jsonCall(
	server: LiveServer,
	method: string,
	route: string,
	body?: unknown,
	opts: { cookie?: string; origin?: string | null } = {}
): Promise<{ res: Response; status: number; data: Record<string, unknown> }> {
	const headers: Record<string, string> = {};
	if (opts.cookie) headers.Cookie = opts.cookie;
	if (body !== undefined) headers['Content-Type'] = 'application/json';
	if (opts.origin !== null) headers.Origin = opts.origin ?? server.origin;
	const res = await fetch(`${server.base}${route}`, {
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

export async function formAction(
	server: LiveServer,
	pagePath: string,
	action: string,
	formData: Record<string, string> = {},
	opts: { cookie?: string; origin?: string | null } = {}
): Promise<{ res: Response; status: number; data: Record<string, unknown>; location: string | null }> {
	const body = new URLSearchParams(formData).toString();
	const url = action ? `${server.base}${pagePath}?/${action}` : `${server.base}${pagePath}`;
	const headers: Record<string, string> = {
		'Content-Type': 'application/x-www-form-urlencoded'
	};
	if (opts.cookie) headers.Cookie = opts.cookie;
	if (opts.origin !== null) headers.Origin = opts.origin ?? server.origin;
	const res = await fetch(url, { method: 'POST', headers, body, redirect: 'manual' });
	const location = res.headers.get('location');
	if (res.status === 303 || res.status === 302) {
		return { res, status: res.status, data: { redirect: location ?? '' }, location };
	}
	const text = await res.text();
	let data: Record<string, unknown> = {};
	try { data = JSON.parse(text); } catch { data = { raw: text }; }
	return { res, status: res.status, data, location };
}

/** Completes first-run setup and returns the session cookie. */
export async function setupAdmin(
	server: LiveServer,
	email: string,
	extra: Record<string, string> = {}
): Promise<string> {
	const res = await formAction(server, '/setup', '', {
		name: 'Live Test Admin',
		email,
		password: PASSWORD,
		companyName: 'Live Test Corp',
		companyEmail: 'billing@livetest.example',
		companyCountry: 'DE',
		language: 'en',
		currency: 'EUR',
		dateFormat: 'DD/MM/YYYY',
		timezone: 'Europe/Berlin',
		defaultTaxRate: '19',
		paymentTermDays: '30',
		...extra
	});
	// SvelteKit returns HTTP 200 with a serialized redirect action result
	// ({"type":"redirect","location":"/dashboard"}) for a JS-disabled form post.
	const target = String(res.location ?? '') || JSON.stringify(res.data);
	if (res.status !== 200 || !target.includes('/dashboard')) {
		throw new Error(`setup failed (${res.status}): ${JSON.stringify(res.data)}`);
	}
	return cookieFrom(res.res);
}

/** Logs in through the JSON API and returns the session cookie. */
export async function loginApi(server: LiveServer, email: string, password = PASSWORD): Promise<string> {
	const res = await jsonCall(server, 'POST', '/api/auth/login', { email, password });
	if (res.status !== 200) throw new Error(`login failed (${res.status}): ${JSON.stringify(res.data)}`);
	return cookieFrom(res.res);
}

export function randomPort(base = 5500): number {
	// Pick a port in a high, unlikely-to-collide range and verify it is free by
	// attempting to bind. Race-free enough for local test runs.
	for (let i = 0; i < 200; i++) {
		const port = base + Math.floor(Math.random() * 800);
		try {
			const srv = net.createServer();
			srv.listen(port, '127.0.0.1');
			srv.close();
			return port;
		} catch { /* busy */ }
	}
	throw new Error(`could not find a free port near ${base}`);
}

export function sleep(ms: number): Promise<void> {
	return new Promise(r => setTimeout(r, ms));
}

// ── TOTP (standalone, so tests don't import the app's DB-bound module) ──────
const B32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

export function base32Decode(input: string): Buffer {
	const cleaned = input.toUpperCase().replace(/[^A-Z2-7]/g, '');
	const bytes: number[] = [];
	let bits = 0;
	let value = 0;
	for (const ch of cleaned) {
		const idx = B32_ALPHABET.indexOf(ch);
		if (idx < 0) throw new Error('Invalid base32 character');
		value = (value << 5) | idx;
		bits += 5;
		if (bits >= 8) {
			bits -= 8;
			bytes.push((value >>> bits) & 0xff);
		}
	}
	return Buffer.from(bytes);
}

/** Current 6-digit TOTP for a base32 secret (SHA1, 30s period). */
export function totpCode(secret: string, time: number = Date.now()): string {
	const counter = Math.floor(time / 1000 / 30);
	const buf = Buffer.alloc(8);
	buf.writeBigUInt64BE(BigInt(counter));
	const mac = crypto.createHmac('sha1', base32Decode(secret)).update(buf).digest();
	const offset = mac[mac.length - 1] & 0x0f;
	const code =
		((mac[offset] & 0x7f) << 24) |
		(mac[offset + 1] << 16) |
		(mac[offset + 2] << 8) |
		mac[offset + 3];
	return String(code % 1_000_000).padStart(6, '0');
}

export function isCommandAvailable(cmd: string): boolean {
	const res = spawnSync('sh', ['-c', `command -v ${cmd}`], { stdio: 'ignore' });
	return res.status === 0;
}
