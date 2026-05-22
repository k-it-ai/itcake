import sanitizeHtml from 'sanitize-html';

export function sanitizeRichText(html: string): string {
	return sanitizeHtml(html, {
		allowedTags: ['b', 'i', 'u', 'strong', 'em', 'br', 'p', 'ul', 'ol', 'li', 'span', 'div', 'sub', 'sup'],
		allowedAttributes: {
			span: ['style'],
			p: ['style'],
			div: ['style'],
		},
		// `<a>` is intentionally absent from `allowedTags` — but pin the
		// scheme allowlist explicitly anyway so a future addition can't
		// accidentally inherit sanitize-html's default `['http','https',
		// 'ftp','mailto']`. The empty allowlist drops `href` schemes
		// outright; pair with `allowedAttributes: { a: ['href', ...] }`
		// and one of these schemes if `<a>` is ever re-enabled.
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

export function sanitizeSmtpError(err: unknown): string {
	const raw = err instanceof Error ? err.message : '';
	if (/ECONNREFUSED|ETIMEDOUT|ENOTFOUND|auth|authentication|credential|tls|certificate/i.test(raw)) {
		return raw
			.replace(/\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}/g, '[redacted]')
			.replace(/[a-zA-Z0-9]([a-zA-Z0-9.-]*[a-zA-Z0-9])?\.[a-zA-Z]{2,}(:\d+)?/g, '[redacted]');
	}
	return 'Email delivery failed';
}

/**
 * UTF-8-safe length truncation. JavaScript's `.slice(0, n)` works in
 * UTF-16 code units, so a slice boundary that falls between a high and
 * low surrogate produces an unpaired surrogate; once V8 converts to
 * UTF-8 for the SQLite binding, the unpaired surrogate becomes either
 * U+FFFD or an invalid 3-byte WTF-8 sequence. Iterating via the string
 * iterator yields full code points (combines surrogate pairs).
 *
 * Caveat: combining sequences (base + diacritic) are NOT joined. This
 * still produces valid UTF-8; the displayed grapheme cluster just gets
 * truncated mid-mark. Acceptable trade-off vs the much-heavier
 * `Intl.Segmenter('grapheme')`.
 */
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
