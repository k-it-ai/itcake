import http from 'node:http';
import https from 'node:https';
import { resolveTarget } from './validate-target.js';
import type { CheckResult } from './ping.js';

export async function checkHttp(target: string, expectedStatus = 200, timeoutMs = 10000): Promise<CheckResult> {
	if (!target) return { status: 'error', responseTimeMs: null, message: 'No target specified' };
	let url = target;
	if (!/^https?:\/\//i.test(url)) url = 'https://' + url;

	let hostname: string;
	let pinnedIp: string;
	try {
		hostname = new URL(url).hostname;
		pinnedIp = await resolveTarget(hostname);
	} catch (e) {
		return { status: 'error', responseTimeMs: null, message: e instanceof Error ? e.message : 'Validation failed' };
	}

	return checkHttpPinned(url, pinnedIp, expectedStatus, timeoutMs);
}

/**
 * Perform the HTTP probe against an already-resolved address. Exposed so the
 * live suite can exercise the real request/timeout/status logic against a
 * local server without weakening the SSRF guard in `checkHttp`.
 */
export async function checkHttpPinned(url: string, pinnedIp: string, expectedStatus = 200, timeoutMs = 10000): Promise<CheckResult> {
	const family = pinnedIp.includes(':') ? 6 : 4;
	const pinnedLookup = (_hostname: string, optionsOrCb: unknown, maybeCb?: unknown) => {
		const cb = (typeof optionsOrCb === 'function' ? optionsOrCb : maybeCb) as (...args: unknown[]) => void;
		const opts = typeof optionsOrCb === 'object' && optionsOrCb !== null ? optionsOrCb as Record<string, unknown> : {};
		if (opts.all) {
			cb(null, [{ address: pinnedIp, family }]);
		} else {
			cb(null, pinnedIp, family);
		}
	};
	const isHttps = url.startsWith('https://');
	const agent = isHttps
		? new https.Agent({ lookup: pinnedLookup, minVersion: 'TLSv1.2' })
		: new http.Agent({ lookup: pinnedLookup });

	const start = Date.now();
	try {
		const controller = new AbortController();
		const timer = setTimeout(() => controller.abort(), timeoutMs);

		const MAX_BODY = 64 * 1024;
		const res = await new Promise<{ status: number }>((resolve, reject) => {
			const mod = isHttps ? https : http;
			const req = mod.request(url, {
				agent,
				signal: controller.signal,
				method: 'HEAD',
				headers: { 'User-Agent': 'ITCake-Monitor/1.0' },
			}, (res) => {
				let bytes = 0;
				res.on('data', (chunk: Buffer) => {
					bytes += chunk.length;
					if (bytes > MAX_BODY) req.destroy(new Error('response body too large'));
				});
				res.on('end', () => resolve({ status: res.statusCode ?? 0 }));
				res.on('error', reject);
			});
			req.on('error', reject);
			req.end();
		});

		clearTimeout(timer);
		agent.destroy();
		const responseTimeMs = Date.now() - start;

		if (res.status === expectedStatus) {
			return { status: 'up', responseTimeMs, message: `HTTP ${res.status}` };
		}
		return { status: 'down', responseTimeMs, message: `HTTP ${res.status} (expected ${expectedStatus})` };
	} catch (e) {
		agent.destroy();
		const responseTimeMs = Date.now() - start;
		const msg = e instanceof Error ? e.message.slice(0, 200) : 'Unknown error';
		return { status: 'down', responseTimeMs, message: msg };
	}
}
