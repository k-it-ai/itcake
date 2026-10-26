import { describe, it, expect } from 'vitest';
import { sanitizeSubjectText } from '../../src/lib/server/sanitize.js';

describe('sanitizeSubjectText', () => {
	it('leaves ordinary names unchanged', () => {
		expect(sanitizeSubjectText('Acme GmbH')).toBe('Acme GmbH');
		expect(sanitizeSubjectText('Müller & Söhne')).toBe('Müller & Söhne');
	});

	it('removes every angle bracket, including nested tag fragments', () => {
		expect(sanitizeSubjectText('<script>alert(1)</script>')).toBe('script alert(1) /script');
		expect(sanitizeSubjectText('<scr<script>ipt>')).toBe('scr script ipt');
		expect(sanitizeSubjectText('Acme <b>GmbH</b>')).toBe('Acme b GmbH /b');
	});

	it('cannot produce a tag after substitution', () => {
		const out = sanitizeSubjectText('<<scri<script>pt>>');
		expect(out).not.toMatch(/[<>]/);
	});

	it('strips CR/LF and other control characters used for header injection', () => {
		const out = sanitizeSubjectText('Acme\r\nBcc: evil@example.com\u0000');
		expect(out).not.toMatch(/[\r\n\x00]/);
		expect(out).toBe('Acme Bcc: evil@example.com');
	});
});
