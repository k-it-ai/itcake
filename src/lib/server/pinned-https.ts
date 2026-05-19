/**
 * DNS-rebind-pinning helpers for outbound HTTPS calls to hard-coded hostnames
 * (Anthropic API, Telegram API). Mirrors the per-connection `lookup` pattern
 * used by `services/emails.ts` (SMTP), `services/backup-offsite.ts` (S3 +
 * WebDAV), `lib/server/checks/{http,rdap,ssl,ping}.ts`. Adding new
 * destinations: wrap them with `pinnedHttpsRequest` (one-shot) or
 * `pinnedFetch` (streaming / SDK fetch override). Both resolve the destination
 * per call via `resolveTarget`, set TLS SNI to the original hostname, and
 * dial the validated IP — DNS-rebind protection is per-connection.
 */
import { request as httpsRequest } from 'node:https';
import type { RequestOptions } from 'node:https';
import type { IncomingMessage } from 'node:http';
import { resolveTarget } from './checks/validate-target.js';

export interface PinnedHttpsResponse {
	status: number;
	headers: IncomingMessage['headers'];
	body: Buffer;
	truncated: boolean;
}

/**
 * One-shot pinned-IP HTTPS request with hard caps. The destination hostname
 * is resolved per-call via `resolveTarget`, the socket is dialled at that IP,
 * and TLS SNI is set to the original hostname. Response is bounded by
 * `maxBodyBytes` (default 16 KiB) — anything larger is truncated and
 * `truncated: true` is returned. Body is buffered in full before returning,
 * so callers should set a tight cap when the response is e.g. an error from
 * Telegram (typically &lt; 1 KiB).
 *
 * Callers MUST handle the case where the resolved IP rotates between calls
 * (DNS-rebind defense). This helper resolves on every call.
 */
export async function pinnedHttpsRequest(opts: {
	method: 'GET' | 'POST' | 'PUT' | 'DELETE';
	url: string;
	headers?: Record<string, string>;
	body?: Buffer | string;
	timeoutMs?: number;
	maxBodyBytes?: number;
}): Promise<PinnedHttpsResponse> {
	const url = new URL(opts.url);
	if (url.protocol !== 'https:') {
		throw new Error('pinnedHttpsRequest requires https:');
	}
	const pinnedIp = await resolveTarget(url.hostname);
	const family = pinnedIp.includes(':') ? 6 : 4;
	const timeoutMs = opts.timeoutMs ?? 10_000;
	const maxBodyBytes = opts.maxBodyBytes ?? 16 * 1024;

	const reqOpts: RequestOptions = {
		method: opts.method,
		host: pinnedIp,
		port: url.port ? Number(url.port) : 443,
		path: url.pathname + url.search,
		servername: url.hostname,
		family,
		headers: {
			host: url.host,
			...(opts.headers ?? {})
		},
		minVersion: 'TLSv1.2'
	};

	return new Promise<PinnedHttpsResponse>((resolve, reject) => {
		const controller = new AbortController();
		const timer = setTimeout(() => controller.abort(), timeoutMs);

		const req = httpsRequest(reqOpts, (res) => {
			const chunks: Buffer[] = [];
			let total = 0;
			let truncated = false;
			res.on('data', (chunk: Buffer) => {
				total += chunk.length;
				if (total > maxBodyBytes) {
					if (!truncated) {
						truncated = true;
						chunks.push(chunk.subarray(0, maxBodyBytes - (total - chunk.length)));
					}
					req.destroy(new Error('response body exceeds cap'));
					return;
				}
				chunks.push(chunk);
			});
			res.on('end', () => {
				clearTimeout(timer);
				resolve({
					status: res.statusCode ?? 0,
					headers: res.headers,
					body: Buffer.concat(chunks),
					truncated
				});
			});
			res.on('error', (err) => { clearTimeout(timer); reject(err); });
		});
		req.on('error', (err) => { clearTimeout(timer); reject(err); });
		controller.signal.addEventListener('abort', () => {
			req.destroy(new Error('request timed out'));
		});
		if (opts.body) req.write(opts.body);
		req.end();
	});
}

/**
 * A `fetch`-compatible function with DNS-rebind pinning. Streams the
 * response body chunk-by-chunk via a `ReadableStream` so SSE / streaming
 * consumers (e.g. Anthropic `messages.stream`) see deltas immediately
 * instead of waiting for the full message. The Anthropic SDK options
 * expose `fetch` (custom implementation) but not `httpAgent`, so this is
 * how we plug pinning into the SDK.
 */
export function pinnedFetch(): typeof fetch {
	return (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
		const inputUrl = typeof input === 'string'
			? input
			: input instanceof URL
				? input.toString()
				: input.url;
		const parsed = new URL(inputUrl);
		if (parsed.protocol !== 'https:') {
			throw new Error('pinnedFetch requires https:');
		}
		const pinnedIp = await resolveTarget(parsed.hostname);
		const family = pinnedIp.includes(':') ? 6 : 4;
		const method = (init?.method ?? 'GET').toUpperCase();

		const headerObj: Record<string, string> = { host: parsed.host };
		if (init?.headers) {
			const h = init.headers;
			if (h instanceof Headers) {
				h.forEach((value, key) => { headerObj[key] = value; });
			} else if (Array.isArray(h)) {
				for (const [k, v] of h) headerObj[k] = v;
			} else {
				for (const [k, v] of Object.entries(h)) headerObj[k] = String(v);
			}
		}

		let body: Buffer | string | undefined;
		if (init?.body != null) {
			if (typeof init.body === 'string') body = init.body;
			else if (init.body instanceof Uint8Array) body = Buffer.from(init.body);
			else if (init.body instanceof ArrayBuffer) body = Buffer.from(init.body);
			else body = String(init.body);
		}

		const reqOpts: RequestOptions = {
			method,
			host: pinnedIp,
			port: parsed.port ? Number(parsed.port) : 443,
			path: parsed.pathname + parsed.search,
			servername: parsed.hostname,
			family,
			headers: headerObj,
			minVersion: 'TLSv1.2'
		};

		return new Promise<Response>((resolve, reject) => {
			const req = httpsRequest(reqOpts, (res) => {
				const responseHeaders = new Headers();
				for (const [k, v] of Object.entries(res.headers)) {
					if (v === undefined) continue;
					responseHeaders.set(k, Array.isArray(v) ? v.join(', ') : v);
				}
				const stream = new ReadableStream<Uint8Array>({
					start(controller) {
						res.on('data', (chunk: Buffer) => {
							controller.enqueue(new Uint8Array(chunk));
						});
						res.on('end', () => controller.close());
						res.on('error', (err) => controller.error(err));
					},
					cancel() {
						req.destroy();
					}
				});
				resolve(new Response(stream, {
					status: res.statusCode ?? 0,
					headers: responseHeaders
				}));
			});
			req.on('error', reject);
			if (init?.signal) {
				if (init.signal.aborted) {
					req.destroy(new Error('aborted'));
				} else {
					init.signal.addEventListener('abort', () => req.destroy(new Error('aborted')));
				}
			}
			if (body) req.write(body);
			req.end();
		});
	}) as typeof fetch;
}
