/**
 * Live guacd remote-desktop test against an existing guacd and target.
 *
 * ITCake is bare-metal/VM only, so this test deliberately does NOT start
 * containers or install anything. Point it at a guacd you already run and a
 * reachable SSH/RDP target:
 *
 *   ITCAKE_LIVE_GUACD_HOST=127.0.0.1 \
 *   ITCAKE_LIVE_GUACD_PORT=4822 \
 *   ITCAKE_LIVE_RD_HOST=10.0.0.20 \
 *   ITCAKE_LIVE_RD_PORT=22 \
 *   ITCAKE_LIVE_RD_USER=itcake \
 *   ITCAKE_LIVE_RD_PASSWORD=... \
 *   npm run test:live -- tests/live/guacd.test.ts
 *
 * Set ITCAKE_LIVE_RD_PROTOCOL=rdp (default ssh) for an RDP target. Without the
 * environment variables the file skips cleanly.
 *
 * It boots the production server, enables remote desktop, enrolls an agent
 * through the public enrollment API, stores the profile, issues a one-time
 * session, exchanges it for a Guacamole token via the popup page, and opens
 * the real WebSocket proxy. guacd performs the real SSH/RDP handshake, so the
 * token HMAC, session claim, protocol check, display defaults, and disconnect
 * lifecycle are all exercised.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomBytes } from 'node:crypto';
import net from 'node:net';
import WebSocket from 'ws';
import {
	startProductionServer, freshDataDir, cleanupDir, jsonCall, setupAdmin,
	randomPort, sleep, type LiveServer
} from './helpers';

const BACKEND_PORT = 5508;
const DATA_DIR = freshDataDir('guacd');
const EMAIL = 'guacd-live@example.com';

const GUACD_HOST = process.env.ITCAKE_LIVE_GUACD_HOST ?? '';
const GUACD_PORT = Number(process.env.ITCAKE_LIVE_GUACD_PORT || 4822);
const PROTOCOL = process.env.ITCAKE_LIVE_RD_PROTOCOL === 'rdp' ? 'rdp' : 'ssh';
const RD_HOST = process.env.ITCAKE_LIVE_RD_HOST ?? '';
const RD_PORT = Number(process.env.ITCAKE_LIVE_RD_PORT || (PROTOCOL === 'rdp' ? 3389 : 22));
const RD_USER = process.env.ITCAKE_LIVE_RD_USER ?? '';
const RD_PASSWORD = process.env.ITCAKE_LIVE_RD_PASSWORD ?? '';

const live = Boolean(GUACD_HOST && RD_HOST && Number.isInteger(GUACD_PORT) && Number.isInteger(RD_PORT));

let server: LiveServer;
let cookie = '';
let agentId = '';
let proxyPort = 0;
let sessionId = '';
let guacToken = '';
let ws: WebSocket | null = null;

async function waitTcp(host: string, port: number, timeoutMs = 30_000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		const ok = await new Promise<boolean>((resolve) => {
			const sock = net.connect({ host, port });
			const done = (v: boolean) => { sock.destroy(); resolve(v); };
			sock.setTimeout(1_000);
			sock.once('connect', () => done(true));
			sock.once('timeout', () => done(false));
			sock.once('error', () => done(false));
		});
		if (ok) return;
		await sleep(250);
	}
	throw new Error(`${host}:${port} did not become reachable`);
}

interface Inbox {
	waitFor: (predicate: (msg: string) => boolean, timeoutMs?: number) => Promise<string>;
}

function inboxFor(socket: WebSocket): Inbox {
	const messages: string[] = [];
	const waiters: Array<{
		predicate: (msg: string) => boolean;
		resolve: (msg: string) => void;
		reject: (err: Error) => void;
		timer: NodeJS.Timeout;
	}> = [];

	const failAll = (err: Error) => {
		for (const w of waiters.splice(0)) {
			clearTimeout(w.timer);
			w.reject(err);
		}
	};

	socket.on('message', (data) => {
		const msg = data.toString();
		messages.push(msg);
		for (let i = waiters.length - 1; i >= 0; i--) {
			if (waiters[i].predicate(msg)) {
				const [w] = waiters.splice(i, 1);
				clearTimeout(w.timer);
				w.resolve(msg);
			}
		}
	});
	socket.once('error', (err) => failAll(err instanceof Error ? err : new Error(String(err))));
	socket.once('close', (code, reason) => failAll(new Error(`WebSocket closed (${code}) ${reason.toString()}`)));

	return {
		waitFor(predicate, timeoutMs = 20_000) {
			const existing = messages.find(predicate);
			if (existing) return Promise.resolve(existing);
			return new Promise<string>((resolve, reject) => {
				const timer = setTimeout(() => {
					const idx = waiters.findIndex(w => w.resolve === resolve);
					if (idx >= 0) waiters.splice(idx, 1);
					reject(new Error(`timed out waiting for a Guacamole instruction; received: ${messages.join(' ').slice(0, 800)}`));
				}, timeoutMs);
				waiters.push({ predicate, resolve, reject, timer });
			});
		}
	};
}

function openWebSocket(token: string, origin: string): Promise<WebSocket> {
	return new Promise((resolve, reject) => {
		const socket = new WebSocket(
			`ws://127.0.0.1:${proxyPort}/?token=${encodeURIComponent(token)}`,
			{ origin }
		);
		const timer = setTimeout(() => {
			socket.terminate();
			reject(new Error('WebSocket did not open'));
		}, 15_000);
		socket.once('open', () => { clearTimeout(timer); resolve(socket); });
		socket.once('error', (err) => { clearTimeout(timer); reject(err); });
	});
}

async function currentSession(): Promise<Record<string, unknown> | undefined> {
	const res = await jsonCall(server, 'GET', `/api/agents/${agentId}/remote-session`, undefined, { cookie });
	const sessions = res.data.sessions as Array<Record<string, unknown>> | undefined;
	return sessions?.find(s => String(s.id) === sessionId);
}

async function waitForEnded(timeoutMs = 20_000): Promise<Record<string, unknown>> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		const s = await currentSession();
		if (s?.endedAt) return s;
		await sleep(250);
	}
	throw new Error('remote session was not marked ended after the WebSocket closed');
}

beforeAll(async () => {
	if (!live) throw new Error('SKIP: ITCAKE_LIVE_GUACD_HOST and ITCAKE_LIVE_RD_HOST are required');

	server = await startProductionServer({
		port: BACKEND_PORT,
		dataDir: DATA_DIR,
		base: `http://127.0.0.1:${BACKEND_PORT}`
	});
	cookie = await setupAdmin(server, EMAIL);

	proxyPort = randomPort(4900);
	const settings = await jsonCall(server, 'POST', '/api/settings', {
		section: 'remoteDesktop',
		data: {
			enabled: true,
			guacdHost: GUACD_HOST,
			guacdPort: GUACD_PORT,
			proxyPort,
			recordingEnabled: false,
			maxSessionMinutes: 5,
			tokenTtlSeconds: 120
		}
	}, { cookie });
	expect(settings.status, JSON.stringify(settings.data)).toBe(200);
	await waitTcp('127.0.0.1', proxyPort);

	const tokenRes = await jsonCall(server, 'POST', '/api/agents/enrollment-tokens', { name: 'guacd-live' }, { cookie });
	expect(tokenRes.status).toBe(201);
	const enroll = await jsonCall(server, 'POST', '/api/rmm/enroll', {
		token: tokenRes.data.token,
		hostname: `guacd-live-${process.pid}`,
		os: 'linux',
		arch: 'amd64',
		osVersion: 'live-test',
		agentVersion: 'live-test',
		hmacSecret: randomBytes(32).toString('hex')
	});
	expect(enroll.status, JSON.stringify(enroll.data)).toBe(201);
	agentId = String(enroll.data.agentId);

	const setProfile = await jsonCall(server, 'POST', `/api/agents/${agentId}/remote-session`, {
		action: 'set-profile',
		profile: {
			protocol: PROTOCOL,
			host: RD_HOST,
			port: RD_PORT,
			username: RD_USER,
			password: RD_PASSWORD,
			...(PROTOCOL === 'rdp' ? { ignoreCert: true } : {})
		}
	}, { cookie });
	expect(setProfile.status, JSON.stringify(setProfile.data)).toBe(200);
}, 120_000);

afterAll(async () => {
	try { ws?.terminate(); } catch { /* ignore */ }
	await server?.stop();
	cleanupDir(DATA_DIR);
});

describe.skipIf(!live)('guacd remote desktop', () => {
	it('reports a reachable guacd even when no local binary is installed', async () => {
		const status = await jsonCall(server, 'GET', '/api/remote-desktop/guacd', undefined, { cookie });
		expect(status.status).toBe(200);
		expect(status.data.host).toBe(GUACD_HOST);
		expect(status.data.port).toBe(GUACD_PORT);
		expect(status.data.reachable).toBe(true);
	});

	it('issues a one-time session token', async () => {
		// No `action` field: handleActionPost routes a plain POST to create.
		const created = await jsonCall(server, 'POST', `/api/agents/${agentId}/remote-session`, {}, { cookie });
		expect(created.status, JSON.stringify(created.data)).toBe(201);
		expect(created.data.protocol).toBe(PROTOCOL);
		expect(String(created.data.popupUrl)).toMatch(/^\/remote-desktop\/[a-f0-9]+$/);
		sessionId = String(created.data.sessionId);
		const popupUrl = String(created.data.popupUrl);

		// The popup page consumes the token and embeds the encrypted Guacamole
		// token that the browser would pass to the WebSocket.
		const page = await fetch(`${server.base}${popupUrl}`, {
			headers: { Cookie: cookie },
			redirect: 'manual'
		});
		expect(page.status).toBe(200);
		const html = await page.text();
		// SvelteKit serializes the page data with devalue, which omits quotes
		// around identifier-like keys: data:{guacToken:"...",...}.
		const match = html.match(/guacToken:"([^"]+)"/);
		expect(match, 'popup page did not embed a guacToken').toBeTruthy();
		guacToken = match![1];
	});

	it('opens a real session through guacd and records the lifecycle', async () => {
		expect(guacToken).toBeTruthy();
		ws = await openWebSocket(guacToken, server.origin);
		const inbox = inboxFor(ws);

		// guacamole-lite emits the internal handshake (empty opcode + UUID) only
		// after guacd has accepted the connection.
		const hello = await inbox.waitFor(msg => msg.startsWith('0.'), 30_000);
		// guacd prefixes its connection id with "$": 0.,37.$<uuid>;
		expect(hello).toMatch(/^0\.,\d+\.\$?[0-9a-f-]+;$/);

		ws.send('4.size,4.1024,3.768,2.96;');

		// A real session sends screen/terminal traffic (images, blobs, rects,
		// cursor updates). Receiving one proves guacd authenticated to the target
		// and is streaming the remote framebuffer through the app's proxy.
		const frame = await inbox.waitFor(
			msg => /^(?:3\.img|4\.blob|4\.rect|5\.cfill|4\.sync|6\.cursor)/.test(msg),
			20_000
		);
		expect(frame).toBeTruthy();

		const started = await currentSession();
		expect(started, 'session not found').toBeTruthy();
		expect(started!.consumedAt).toBeTruthy();
		expect(started!.startedAt).toBeTruthy();
		expect(started!.endedAt).toBeFalsy();

		ws.close();
		ws = null;
		const ended = await waitForEnded();
		expect(ended.endedAt).toBeTruthy();
	}, 60_000);
});
