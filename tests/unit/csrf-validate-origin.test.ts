/**
 * Direct unit coverage for `validateOrigin` in `src/hooks.server.ts`.
 * This is the single point of CSRF defence on cookie-authenticated
 * endpoints; any regression turns every authenticated POST into a CSRF
 * target.
 *
 * Branches pinned here:
 *   - GET/HEAD/OPTIONS short-circuit
 *   - /api/rmm/* carve-out (non-cookie agent traffic)
 *   - /api/csp-report carve-out (browsers don't send matching Origin)
 *   - Origin matches event.url.origin → allow
 *   - Origin mismatches → 403
 *   - Origin absent + Referer matches → allow
 *   - Origin absent + Referer mismatches → 403
 *   - Origin absent + malformed Referer → 403 (not 500)
 *   - Origin absent + Referer absent → 403
 */
import { describe, it, expect } from 'vitest';
import { isHttpError } from '@sveltejs/kit';
import { validateOrigin } from '../../src/hooks.server.js';

type Headers = Record<string, string>;

function mockEvent(
	method: string,
	pathname: string,
	headers: Headers = {},
	origin = 'https://itcake.example'
) {
	const url = new URL(origin + pathname);
	return {
		request: {
			method,
			headers: {
				get: (name: string): string | null => headers[name.toLowerCase()] ?? null
			}
		},
		url
	} as unknown as Parameters<typeof validateOrigin>[0];
}

describe('validateOrigin — CSRF gate', () => {
	it('passes GET / HEAD / OPTIONS without checking Origin', () => {
		for (const method of ['GET', 'HEAD', 'OPTIONS']) {
			expect(() =>
				validateOrigin(mockEvent(method, '/api/invoices'))
			).not.toThrow();
		}
	});

	it('skips the check entirely for /api/rmm/* (bearer-authenticated agents)', () => {
		// No Origin header, no Referer → would normally 403; the carve-out
		// returns early.
		expect(() =>
			validateOrigin(mockEvent('POST', '/api/rmm/checkin'))
		).not.toThrow();
		expect(() =>
			validateOrigin(mockEvent('POST', '/api/rmm/enroll'))
		).not.toThrow();
		expect(() =>
			validateOrigin(mockEvent('POST', '/api/rmm/download/linux/amd64'))
		).not.toThrow();
	});

	it('skips the check for /api/csp-report (browsers omit Origin on report POSTs)', () => {
		expect(() =>
			validateOrigin(mockEvent('POST', '/api/csp-report'))
		).not.toThrow();
	});

	it('rejects a POST with cross-origin Origin header (403)', () => {
		try {
			validateOrigin(
				mockEvent('POST', '/api/invoices', { origin: 'https://evil.example' })
			);
			expect.fail('should have thrown');
		} catch (e) {
			expect(isHttpError(e)).toBe(true);
			if (isHttpError(e)) expect(e.status).toBe(403);
		}
	});

	it('accepts a POST with matching Origin header', () => {
		expect(() =>
			validateOrigin(
				mockEvent('POST', '/api/invoices', { origin: 'https://itcake.example' })
			)
		).not.toThrow();
	});

	it('falls back to Referer when Origin is absent (matching → allow)', () => {
		expect(() =>
			validateOrigin(
				mockEvent('POST', '/api/invoices', {
					referer: 'https://itcake.example/invoices/new'
				})
			)
		).not.toThrow();
	});

	it('falls back to Referer when Origin is absent (mismatching → 403)', () => {
		try {
			validateOrigin(
				mockEvent('POST', '/api/invoices', {
					referer: 'https://evil.example/somewhere'
				})
			);
			expect.fail('should have thrown');
		} catch (e) {
			expect(isHttpError(e)).toBe(true);
			if (isHttpError(e)) expect(e.status).toBe(403);
		}
	});

	it('rejects with 403 (not 500) when Referer is malformed', () => {
		try {
			validateOrigin(
				mockEvent('POST', '/api/invoices', { referer: 'not a url' })
			);
			expect.fail('should have thrown');
		} catch (e) {
			expect(isHttpError(e)).toBe(true);
			if (isHttpError(e)) expect(e.status).toBe(403);
		}
	});

	it('rejects with 403 when both Origin and Referer are absent', () => {
		try {
			validateOrigin(mockEvent('POST', '/api/invoices'));
			expect.fail('should have thrown');
		} catch (e) {
			expect(isHttpError(e)).toBe(true);
			if (isHttpError(e)) expect(e.status).toBe(403);
		}
	});

	it('rejects an Origin matching a different scheme (http vs https)', () => {
		// http://itcake.example != https://itcake.example by URL.origin
		// semantics. The check compares Origin against event.url.origin,
		// which carries the request's scheme. A downgrade attack from
		// http would fail this gate.
		try {
			validateOrigin(
				mockEvent('POST', '/api/invoices', { origin: 'http://itcake.example' })
			);
			expect.fail('should have thrown');
		} catch (e) {
			expect(isHttpError(e)).toBe(true);
			if (isHttpError(e)) expect(e.status).toBe(403);
		}
	});

	it('rejects an Origin matching the host but on a different port', () => {
		try {
			validateOrigin(
				mockEvent('POST', '/api/invoices', {
					origin: 'https://itcake.example:8080'
				})
			);
			expect.fail('should have thrown');
		} catch (e) {
			expect(isHttpError(e)).toBe(true);
			if (isHttpError(e)) expect(e.status).toBe(403);
		}
	});
});
