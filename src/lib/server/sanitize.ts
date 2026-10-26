import sanitizeHtml from 'sanitize-html';

export function sanitizeRichText(html: string): string {
	return sanitizeHtml(html, {
		allowedTags: ['b', 'i', 'u', 'strong', 'em', 'br', 'p', 'ul', 'ol', 'li', 'span', 'div', 'sub', 'sup'],
		allowedAttributes: {
			span: ['style'],
			p: ['style'],
			div: ['style'],
		},
		allowedSchemes: ['http', 'https', 'mailto'],
		allowedSchemesByTag: {},
		allowedSchemesAppliedToAttributes: ['href', 'src', 'cite'],
		allowProtocolRelative: false,
		allowedStyles: {
			'*': {
				'text-align': [/^(left|right|center|justify)$/],
				'text-decoration': [/^(underline|line-through|none)$/],
				'font-weight': [/^(bold|normal|[1-9]00)$/],
				'font-style': [/^(italic|normal)$/],
			}
		}
	});
}

export function safeFilename(s: string): string {
	return s.replace(/[^A-Za-z0-9._-]/g, '-');
}

export function escapeHtml(s: string): string {
	return s
		.replace(/&/g, '&amp;')
		.replace(/</g, '&lt;')
		.replace(/>/g, '&gt;')
		.replace(/"/g, '&quot;')
		.replace(/'/g, '&#39;');
}

export function sanitizeHeader(s: string): string {
	return s.replace(/[\x00-\x1f\x7f\u2028\u2029]/g, ' ').trim();
}

/**
 * Plain-text value for an email subject or other non-HTML context. Every
 * angle bracket is removed in one pass, so no tag fragment can be
 * reconstructed by a later parse. Control characters become spaces, which
 * makes header injection impossible, and runs of spaces are collapsed.
 */
export function sanitizeSubjectText(s: string): string {
	return sanitizeHeader(s.replace(/[<>]/g, ' ')).replace(/ {2,}/g, ' ');
}

export function sanitizeSmtpError(err: unknown): string {
	const raw = err instanceof Error ? err.message : '';
	if (/ECONNREFUSED|ETIMEDOUT|ENOTFOUND|auth|authentication|credential|tls|certificate/i.test(raw)) {
		return raw
			.replace(/\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}/g, '[redacted]')
			.replace(/[a-zA-Z0-9]([a-zA-Z0-9.-]*[a-zA-Z0-9])?\.[a-zA-Z]{2,}(:\d+)?/g, '[redacted]');
	}
	return 'Email delivery failed';
}

// Iterates code points; combining marks are not joined.
export function truncateChars(s: string, maxCodePoints: number): string {
	if (maxCodePoints <= 0) return '';
	if (s.length <= maxCodePoints) return s;
	let out = '';
	let count = 0;
	for (const ch of s) {
		if (count >= maxCodePoints) break;
		out += ch;
		count++;
	}
	return out;
}
