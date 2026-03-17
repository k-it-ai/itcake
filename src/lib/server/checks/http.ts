import http from 'node:http';
import https from 'node:https';
import { validateHostname, resolveAndValidate } from './validate-target.js';
import type { CheckResult } from './ping.js';

export async function checkHttp(target: string, expectedStatus = 200, timeoutMs = 10000): Promise<CheckResult> {
	if (!target) return { status: 'error', responseTimeMs: null, message: 'No target specified' };
	let url = target;
	if (!/^https?:\/\//i.test(url)) url = 'https://' + url;

	let hostname: string;
	let pinnedIp: string;
	try {
		hostname = new URL(url).hostname;
		validateHostname(hostname);
		pinnedIp = await resolveAndValidate(hostname);
	} catch (e) {
		return { status: 'error', responseTimeMs: null, message: e instanceof Error ? e.message : 'Validation failed' };
	}

	// Pin DNS resolution to the validated IP — prevents DNS rebinding
	const family = pinnedIp.includes(':') ? 6 : 4;
	const pinnedLookup = (_hostname: string, _options: unknown, callback: (err: NodeJS.ErrnoException | null, address: string, family: number) => void) => {
		callback(null, pinnedIp, family);
	};
	const isHttps = url.startsWith('https://');
	const agent = isHttps
		? new https.Agent({ lookup: pinnedLookup })
		: new http.Agent({ lookup: pinnedLookup });

	const start = Date.now();
	try {
		const controller = new AbortController();
		const timer = setTimeout(() => controller.abort(), timeoutMs);

		const res = await new Promise<{ status: number }>((resolve, reject) => {
			const mod = isHttps ? https : http;
			const req = mod.request(url, {
				agent,
				signal: controller.signal,
				headers: { 'User-Agent': 'ITCake-Monitor/1.0' },
			}, (res) => {
				res.resume(); // drain
				resolve({ status: res.statusCode ?? 0 });
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
		// Treat any response (including redirects) as "the server responded"
		return { status: 'down', responseTimeMs, message: `HTTP ${res.status} (expected ${expectedStatus})` };
	} catch (e) {
		agent.destroy();
		const responseTimeMs = Date.now() - start;
		const msg = e instanceof Error ? e.message.slice(0, 200) : 'Unknown error';
		return { status: 'down', responseTimeMs, message: msg };
	}
}
