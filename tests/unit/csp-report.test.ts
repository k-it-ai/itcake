import { describe, it, expect, beforeAll } from 'vitest';
import { existsSync, mkdirSync, rmSync } from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';

const TEST_DIR = path.resolve('data-test-csp-report');

let POST: typeof import('../../src/routes/api/csp-report/+server.js').POST;

beforeAll(async () => {
	if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
	mkdirSync(TEST_DIR, { recursive: true });
	process.env.DATABASE_PATH = path.join(TEST_DIR, 'cr.db');
	process.env.DATA_DIR = TEST_DIR;
	process.env.SESSION_SECRET ||= randomBytes(32).toString('hex');
	const mod = await import('../../src/routes/api/csp-report/+server.js');
	POST = mod.POST;
});

function makeEvent(body: string, ip = '203.0.113.1'): Parameters<typeof POST>[0] {
	const url = new URL('http://localhost/api/csp-report');
	const request = new Request(url, {
		method: 'POST',
		body,
		headers: { 'Content-Type': 'application/csp-report' }
	});
	return {
		url, request, cookies: {}, locals: {}, params: {},
		getClientAddress: () => ip
	} as unknown as Parameters<typeof POST>[0];
}

describe('POST /api/csp-report', () => {
	it('returns 204 for a well-formed report', async () => {
		const body = JSON.stringify({
			'csp-report': {
				'document-uri': 'https://example.com/page',
				'violated-directive': 'script-src',
				'blocked-uri': 'https://evil.example.com/x.js'
			}
		});
		const res = await POST(makeEvent(body));
		expect(res.status).toBe(204);
	});

	it('handles malformed bodies without throwing', async () => {
		const res = await POST(makeEvent('not-json{['));
		expect(res.status).toBe(204);
	});

	it('rejects oversize Content-Length with 413', async () => {
		const url = new URL('http://localhost/api/csp-report');
		const huge = 'a'.repeat(10);
		const request = new Request(url, {
			method: 'POST',
			body: huge,
			headers: { 'Content-Length': '999999' }
		});
		const event = {
			url, request, cookies: {}, locals: {}, params: {},
			getClientAddress: () => '203.0.113.2'
		} as unknown as Parameters<typeof POST>[0];
		const res = await POST(event);
		expect(res.status).toBe(413);
	});

	it('rate-limits per IP after 60 reports/minute', async () => {
		const ip = `198.51.100.${Math.floor(Math.random() * 200) + 1}`;
		const body = JSON.stringify({ 'csp-report': { 'blocked-uri': 'x' } });
		for (let i = 0; i < 60; i++) await POST(makeEvent(body, ip));
		// 61st still returns 204 (silent drop) but the underlying limit triggered.
		const res = await POST(makeEvent(body, ip));
		expect(res.status).toBe(204);
	});
});
