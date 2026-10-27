import { describe, it, expect } from 'vitest';
import { parseOrigin, isSecureSessionCookie } from '../../src/lib/server/origin.js';

describe('parseOrigin', () => {
	it('accepts canonical https origins', () => {
		expect(parseOrigin('https://invoices.example.com')).toEqual({
			origin: 'https://invoices.example.com',
			protocol: 'https:',
			hostname: 'invoices.example.com',
			isLoopback: false
		});
	});

	it('accepts loopback http origins for local production smoke tests', () => {
		expect(parseOrigin('http://127.0.0.1:3000').origin).toBe('http://127.0.0.1:3000');
		expect(parseOrigin('http://localhost:3000').isLoopback).toBe(true);
		expect(parseOrigin('http://[::1]:3000').origin).toBe('http://[::1]:3000');
	});

	it('rejects missing, relative, and non-http origins', () => {
		expect(() => parseOrigin('')).toThrow(/empty/i);
		expect(() => parseOrigin('/invoices')).toThrow(/absolute URL/i);
		expect(() => parseOrigin('ftp://invoices.example.com')).toThrow(/http:\/\/ or https:\/\//i);
	});

	it('rejects credentials, paths, queries, fragments, and trailing slashes', () => {
		expect(() => parseOrigin('https://user:pass@example.com')).toThrow(/username or password/i);
		expect(() => parseOrigin('https://example.com/invoices')).toThrow(/without a path/i);
		expect(() => parseOrigin('https://example.com/?a=1')).toThrow(/query string or fragment/i);
		expect(() => parseOrigin('https://example.com/#frag')).toThrow(/query string or fragment/i);
		expect(() => parseOrigin('https://example.com/')).toThrow(/trailing slash/i);
	});
});

describe('isSecureSessionCookie', () => {
	it('is Secure for https and defaults to Secure for http in production', () => {
		expect(isSecureSessionCookie('https://invoices.example.com', 'production')).toBe(true);
		expect(isSecureSessionCookie('http://127.0.0.1:3000', 'production')).toBe(true);
	});

	it('honors ALLOW_INSECURE_COOKIES for loopback smoke tests', () => {
		const prev = process.env.ALLOW_INSECURE_COOKIES;
		process.env.ALLOW_INSECURE_COOKIES = 'true';
		try {
			expect(isSecureSessionCookie('http://127.0.0.1:3000', 'production')).toBe(false);
		} finally {
			if (prev === undefined) delete process.env.ALLOW_INSECURE_COOKIES;
			else process.env.ALLOW_INSECURE_COOKIES = prev;
		}
	});

	it('falls back to NODE_ENV when ORIGIN is unset', () => {
		expect(isSecureSessionCookie(undefined, 'production')).toBe(true);
		expect(isSecureSessionCookie(undefined, 'development')).toBe(false);
		expect(isSecureSessionCookie(undefined, 'test')).toBe(false);
	});

	it('falls back to NODE_ENV instead of throwing on a malformed ORIGIN', () => {
		expect(isSecureSessionCookie('not-a-url', 'development')).toBe(false);
		expect(isSecureSessionCookie('https://example.com/', 'development')).toBe(false);
		expect(isSecureSessionCookie('not-a-url', 'production')).toBe(true);
	});
});
