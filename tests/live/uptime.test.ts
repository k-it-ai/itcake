/**
 * Live uptime-monitor checks (§21).
 *
 * The hermetic suite covers target validation and check pruning, but the
 * actual probe code (HTTP status handling, timeouts, TLS expiry reading, RDAP
 * parsing) had no test. This file drives the real network functions:
 *
 *   - HTTP 200 -> up, HTTP 503 -> down
 *   - loopback/link-local targets are refused by the SSRF guard
 *   - a real TLS handshake yields the certificate's expiry date
 *   - a real RDAP lookup populates a domain expiry (skipped when offline)
 *
 * `checkHttpPinned` is the production helper that accepts an already-resolved
 * address; `checkHttp`/`checkSsl` remain the guarded entry points used by the
 * scheduler. The TLS probe uses a public host because the production function
 * always connects to port 443; the self-signed/expired certificate path is
 * intentionally accepted by `checkSsl` and is unchanged from the audited code.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { checkHttp, checkHttpPinned } from '../../src/lib/server/checks/http.js';
import { checkSsl } from '../../src/lib/server/checks/ssl.js';
import { checkDomainExpiry } from '../../src/lib/server/checks/rdap.js';

let httpServer: Server;
let httpPort = 0;

function isOfflineError(message: string): boolean {
	return /DNS resolution failed|ENOTFOUND|EAI_AGAIN|ETIMEDOUT|ECONNREFUSED|ECONNRESET|fetch failed|HTTP 429|targetResolutionFailed/i.test(message);
}

beforeAll(async () => {
	httpServer = createServer((req, res) => {
		if (req.url === '/ok') {
			res.writeHead(200, { 'Content-Type': 'text/plain' });
			res.end('ok');
			return;
		}
		if (req.url === '/down') {
			res.writeHead(503, { 'Content-Type': 'text/plain' });
			res.end('down');
			return;
		}
		res.writeHead(404);
		res.end();
	});
	await new Promise<void>((resolve) => httpServer.listen(0, '127.0.0.1', resolve));
	httpPort = (httpServer.address() as AddressInfo).port;
}, 30_000);

afterAll(async () => {
	await new Promise<void>((resolve) => httpServer?.close(() => resolve()));
});

describe('HTTP monitor probe', () => {
	it('reports up for the expected status', async () => {
		const result = await checkHttpPinned(`http://127.0.0.1:${httpPort}/ok`, '127.0.0.1', 200);
		expect(result.status).toBe('up');
		expect(result.message).toBe('HTTP 200');
		expect(typeof result.responseTimeMs).toBe('number');
	});

	it('reports down for an unexpected status', async () => {
		const result = await checkHttpPinned(`http://127.0.0.1:${httpPort}/down`, '127.0.0.1', 200);
		expect(result.status).toBe('down');
		expect(result.message).toBe('HTTP 503 (expected 200)');
	});

	it('refuses loopback and link-local targets through the guarded entry point', async () => {
		const loopback = await checkHttp(`http://127.0.0.1:${httpPort}/ok`);
		expect(loopback.status).toBe('error');
		expect(loopback.message).toContain('targetBlockedIpRange');

		const metadata = await checkHttp('http://169.254.169.254/latest/meta-data/');
		expect(metadata.status).toBe('error');
		expect(metadata.message).toContain('targetBlockedIpRange');
	});
});

describe('SSL expiry probe', () => {
	it('reads a real certificate expiry from a TLS handshake', async (ctx) => {
		try {
			const result = await checkSsl('example.com');
			expect(result.expiryDate).toMatch(/^\d{4}-\d{2}-\d{2}$/);
			expect(result.daysRemaining).toBeGreaterThan(0);
		} catch (e) {
			const message = e instanceof Error ? e.message : String(e);
			// The live suite is opt-in and may run offline.
			if (isOfflineError(message)) {
				ctx.skip();
				return;
			}
			throw e;
		}
	}, 30_000);
});

describe('RDAP domain expiry probe', () => {
	it('populates an expiry date for a real domain', async (ctx) => {
		try {
			const result = await checkDomainExpiry('example.com');
			expect(result.expiryDate).toMatch(/^\d{4}-\d{2}-\d{2}$/);
			expect(result.daysRemaining).toBeGreaterThan(0);
		} catch (e) {
			const message = e instanceof Error ? e.message : String(e);
			// A genuine RDAP response with an unparseable body must still fail.
			if (isOfflineError(message)) {
				ctx.skip();
				return;
			}
			throw e;
		}
	}, 30_000);
});
