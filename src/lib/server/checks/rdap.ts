import https from 'node:https';
import { resolveTarget } from './validate-target.js';

interface DomainExpiryResult {
	expiryDate: string;
	daysRemaining: number;
}

const MAX_RDAP_BODY = 512 * 1024; // 512KB limit for RDAP responses
const MAX_REDIRECTS = 5;

function pinnedHttpsGet(url: URL, pinnedIp: string, headers: Record<string, string>, signal: AbortSignal): Promise<{ status: number; locationHeader: string | null; bodyText: string | null }> {
	return new Promise((resolve, reject) => {
		const family = pinnedIp.includes(':') ? 6 : 4;
		const lookup = (_h: string, optionsOrCb: unknown, maybeCb?: unknown) => {
			const cb = (typeof optionsOrCb === 'function' ? optionsOrCb : maybeCb) as (...a: unknown[]) => void;
			const opts = typeof optionsOrCb === 'object' && optionsOrCb !== null ? optionsOrCb as Record<string, unknown> : {};
			if (opts.all) cb(null, [{ address: pinnedIp, family }]);
			else cb(null, pinnedIp, family);
		};
		const agent = new https.Agent({ lookup, minVersion: 'TLSv1.2' });
		const req = https.request({
			method: 'GET',
			hostname: url.hostname,
			port: url.port || 443,
			path: url.pathname + url.search,
			headers: { ...headers, host: url.host },
			servername: url.hostname,
			agent,
			signal
		}, (res) => {
			const status = res.statusCode ?? 0;
			const locationHeader = res.headers.location ?? null;
			if (status >= 300 && status < 400) {
				res.resume();
				agent.destroy();
				resolve({ status, locationHeader: typeof locationHeader === 'string' ? locationHeader : null, bodyText: null });
				return;
			}
			let total = 0;
			let aborted = false;
			const chunks: Buffer[] = [];
			res.on('data', (c: Buffer) => {
				if (aborted) return;
				total += c.length;
				if (total > MAX_RDAP_BODY) {
					aborted = true;
					req.destroy(new Error('RDAP response too large'));
					return;
				}
				chunks.push(c);
			});
			res.on('end', () => {
				if (aborted) return;
				agent.destroy();
				resolve({ status, locationHeader: null, bodyText: Buffer.concat(chunks).toString('utf-8') });
			});
			res.on('error', (e) => { agent.destroy(); reject(e); });
		});
		req.on('error', (e) => { agent.destroy(); reject(e); });
		req.end();
	});
}

function extractBaseDomain(input: string): string {
	if (!input) throw new Error('No domain specified');
	const domain = input.replace(/^https?:\/\//i, '').split('/')[0].split(':')[0].toLowerCase();
	const parts = domain.split('.');
	const twoPartTlds = ['co.uk', 'com.au', 'co.nz', 'com.br', 'co.za', 'org.uk', 'net.au', 'co.jp', 'co.kr'];
	if (parts.length >= 3) {
		const lastTwo = parts.slice(-2).join('.');
		if (twoPartTlds.includes(lastTwo)) {
			return parts.slice(-3).join('.');
		}
	}
	return parts.length >= 2 ? parts.slice(-2).join('.') : domain;
}

export async function checkDomainExpiry(domain: string, timeoutMs = 15000): Promise<DomainExpiryResult> {
	const baseDomain = extractBaseDomain(domain);
	let currentUrl = `https://rdap.org/domain/${encodeURIComponent(baseDomain)}`;
	const headers = { 'Accept': 'application/rdap+json, application/json' };
	const signal = AbortSignal.timeout(timeoutMs);

	let bodyText: string | null = null;
	let lastStatus = 0;
	for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
		const url = new URL(currentUrl);
		if (hop > 0 && url.protocol !== 'https:') {
			throw new Error('RDAP redirect refused: cleartext after first hop');
		}
		if (url.protocol !== 'https:') {
			// First-hop must be https too — rdap.org always is.
			throw new Error('RDAP first hop must be https://');
		}
		const pinnedIp = await resolveTarget(url.hostname);

		const result = await pinnedHttpsGet(url, pinnedIp, headers, signal);
		lastStatus = result.status;

		if (result.status >= 300 && result.status < 400) {
			if (!result.locationHeader) throw new Error('RDAP redirect without Location header');
			currentUrl = new URL(result.locationHeader, currentUrl).toString();
			continue;
		}
		bodyText = result.bodyText;
		break;
	}

	if (lastStatus < 200 || lastStatus >= 300 || bodyText == null) {
		throw new Error(`RDAP lookup failed: HTTP ${lastStatus || 'no response'}`);
	}

	const data = JSON.parse(bodyText) as {
		events?: Array<{ eventAction: string; eventDate: string }>;
	};

	const expEvent = data.events?.find(e => e.eventAction === 'expiration');
	if (!expEvent?.eventDate) {
		throw new Error('No expiration date in RDAP response');
	}

	const expiryDate = new Date(expEvent.eventDate).toISOString().split('T')[0];
	const daysRemaining = Math.floor((new Date(expEvent.eventDate).getTime() - Date.now()) / (86400 * 1000));
	return { expiryDate, daysRemaining };
}
