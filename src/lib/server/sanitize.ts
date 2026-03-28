/**
 * Shared sanitization utilities — single source of truth.
 * Used across API routes, email handlers, and file download endpoints.
 */

import sanitizeHtml from 'sanitize-html';

/**
 * Sanitize rich text HTML from the editor. Allows safe formatting tags only.
 * Strips scripts, event handlers, and dangerous attributes.
 */
export function sanitizeRichText(html: string): string {
	return sanitizeHtml(html, {
		allowedTags: ['b', 'i', 'u', 'strong', 'em', 'br', 'p', 'ul', 'ol', 'li', 'span', 'div', 'sub', 'sup'],
		allowedAttributes: {
			span: ['style'],
			p: ['style'],
			div: ['style'],
		},
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

/**
 * Sanitize a string for safe use in Content-Disposition filenames.
 * Strips everything except alphanumerics, dots, hyphens, and underscores.
 */
export function safeFilename(s: string): string {
	return s.replace(/[^A-Za-z0-9._-]/g, '-');
}

/** Escape HTML special characters to prevent XSS in rendered output. */
export function escapeHtml(s: string): string {
	return s
		.replace(/&/g, '&amp;')
		.replace(/</g, '&lt;')
		.replace(/>/g, '&gt;')
		.replace(/"/g, '&quot;')
		.replace(/'/g, '&#39;');
}

/** Strip all ASCII control characters from header values to prevent header injection. */
export function sanitizeHeader(s: string): string {
	return s.replace(/[\x00-\x1f\x7f\u2028\u2029]/g, ' ').trim();
}

/**
 * Sanitize SMTP/Nodemailer error messages for client-facing responses.
 * Only surfaces known safe error patterns; redacts IP addresses.
 * Returns a generic message for unrecognized errors.
 */
export function sanitizeSmtpError(err: unknown): string {
	const raw = err instanceof Error ? err.message : '';
	if (/ECONNREFUSED|ETIMEDOUT|ENOTFOUND|auth|authentication|credential|tls|certificate/i.test(raw)) {
		return raw
			.replace(/\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}/g, '[redacted]')
			.replace(/[a-zA-Z0-9]([a-zA-Z0-9.-]*[a-zA-Z0-9])?\.[a-zA-Z]{2,}(:\d+)?/g, '[redacted]');
	}
	return 'Email delivery failed';
}
