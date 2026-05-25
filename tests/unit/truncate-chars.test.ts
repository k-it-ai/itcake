/**
 * UTF-8-safe length truncation. `.slice(0, n)` on a string ending mid-
 * surrogate-pair produces an unpaired surrogate that becomes U+FFFD or
 * a WTF-8 sequence when V8 hands it to the SQLite binding. `truncateChars`
 * iterates code points so the cut always lands at a valid boundary.
 */
import { describe, it, expect } from 'vitest';
import { truncateChars } from '../../src/lib/server/sanitize.js';

describe('truncateChars', () => {
	it('returns the input unchanged when it fits', () => {
		expect(truncateChars('hello', 10)).toBe('hello');
	});

	it('truncates to the requested code-point count for ASCII', () => {
		expect(truncateChars('abcdefghij', 5)).toBe('abcde');
	});

	it('returns empty string for zero or negative maxCodePoints', () => {
		expect(truncateChars('hello', 0)).toBe('');
		expect(truncateChars('hello', -1)).toBe('');
	});

	it('does not split surrogate pairs (BMP boundary)', () => {
		// 😀 is U+1F600 — a surrogate pair (2 UTF-16 code units).
		// Plain `.slice(0, 3)` on "ab😀" would yield "ab\uD83D" — unpaired.
		const s = 'ab😀cd';
		// Code-point count is 5 (a, b, 😀, c, d).
		expect(truncateChars(s, 3)).toBe('ab😀');
		// The emoji counts as ONE code point; cutting AT it includes it.
		expect(truncateChars(s, 2)).toBe('ab');
	});

	it('handles strings made entirely of supplementary-plane code points', () => {
		const s = '🟢🟡🔴🟠🟣';
		expect(truncateChars(s, 3)).toBe('🟢🟡🔴');
		expect([...truncateChars(s, 4)].length).toBe(4);
	});

	it('never produces an unpaired surrogate in the output', () => {
		const s = 'X😀Y😀Z😀';
		for (let n = 0; n <= [...s].length; n++) {
			const out = truncateChars(s, n);
			for (let i = 0; i < out.length; i++) {
				const cu = out.charCodeAt(i);
				if (cu >= 0xD800 && cu <= 0xDBFF) {
					// High surrogate — must be followed by a low surrogate.
					const next = out.charCodeAt(i + 1);
					expect(next).toBeGreaterThanOrEqual(0xDC00);
					expect(next).toBeLessThanOrEqual(0xDFFF);
				}
				if (cu >= 0xDC00 && cu <= 0xDFFF) {
					// Low surrogate — must be preceded by a high surrogate.
					const prev = out.charCodeAt(i - 1);
					expect(prev).toBeGreaterThanOrEqual(0xD800);
					expect(prev).toBeLessThanOrEqual(0xDBFF);
				}
			}
		}
	});

	it('preserves combining sequences as separate code points (documented trade-off)', () => {
		// é = "e" + U+0301 (combining acute). Two code points. truncateChars
		// does NOT join them — cutting at 1 yields just the base "e".
		const s = 'éf';
		expect(truncateChars(s, 1)).toBe('e');
		expect(truncateChars(s, 2)).toBe('é');
	});
});
