/**
 * AI input sanitizer. Two jobs:
 *   1. Reject prompts that look like prompt-injection attempts.
 *   2. Strip Unicode classes that bypass visual review (bidirectional
 *      override, zero-width, format characters).
 *
 * Both are best-effort defenses — the model itself is the last line. But
 * stripping bidi chars closes the obvious "invisible prepended instruction"
 * vector before it ever reaches Claude, and the regex set catches the most
 * common injection phrasings so you can decline at the boundary instead of
 * relying on the model to refuse.
 *
 * Inspired by Breeze's aiInputSanitizer.ts but pruned for itcake's single-
 * user scope.
 */

const MAX_LENGTH_BYTES = 10 * 1024;

const INJECTION_PATTERNS: RegExp[] = [
	/ignore\s+(?:all\s+|previous\s+|prior\s+|the\s+above\s+)?instructions?/i,
	/disregard\s+(?:all\s+|previous\s+|prior\s+|the\s+above\s+)?instructions?/i,
	/forget\s+(?:everything|all\s+previous|the\s+above|your\s+instructions)/i,
	/(?:you\s+are\s+now|act\s+as)\s+(?:dan|jailbreak|developer\s+mode|root)/i,
	/system\s*[:=]\s*you\s+(?:are|will|must)/i,
	/^\s*<\|?(?:im_start|im_end|system|assistant)\|?>/i,
	/```(?:system|developer|root)\s*\n/i,
	/(?:reveal|print|show|dump)\s+(?:your\s+)?(?:system\s+)?(?:prompt|instructions|guidelines)/i,
	/override\s+(?:your\s+)?(?:safety|ethical|moral)/i,
	/pretend\s+(?:you\s+(?:are|have|can)|that\s+you)/i,
	/from\s+now\s+on\s*,?\s+you\s+(?:are|will|must|should)/i
];

const DANGEROUS_UNICODE = /[​-‏‪-‮⁠-⁤⁦-⁩﻿]/g;

export interface SanitizeResult {
	clean: string;
	warnings: string[];
	rejected: boolean;
	rejectReason?: string;
}

export function sanitizeUserText(input: unknown): SanitizeResult {
	const warnings: string[] = [];
	if (typeof input !== 'string') {
		return { clean: '', warnings, rejected: true, rejectReason: 'expected text input' };
	}
	if (Buffer.byteLength(input, 'utf8') > MAX_LENGTH_BYTES) {
		return { clean: '', warnings, rejected: true, rejectReason: `input exceeds ${MAX_LENGTH_BYTES / 1024} KiB cap` };
	}
	let clean = input;
	if (DANGEROUS_UNICODE.test(clean)) {
		warnings.push('stripped invisible control characters');
		clean = clean.replace(DANGEROUS_UNICODE, '');
	}
	for (const re of INJECTION_PATTERNS) {
		if (re.test(clean)) {
			return {
				clean,
				warnings,
				rejected: true,
				rejectReason: 'input matched a known prompt-injection pattern; rephrase and try again'
			};
		}
	}
	return { clean, warnings, rejected: false };
}

export function sanitizePageContext(ctx: unknown): Record<string, unknown> {
	if (!ctx || typeof ctx !== 'object') return {};
	const out: Record<string, unknown> = {};
	for (const [k, v] of Object.entries(ctx as Record<string, unknown>)) {
		if (typeof v === 'string') {
			const r = sanitizeUserText(v);
			if (!r.rejected) out[k] = r.clean.slice(0, 1000);
		} else if (typeof v === 'number' || typeof v === 'boolean') {
			out[k] = v;
		} else if (Array.isArray(v)) {
			out[k] = v.slice(0, 50).map(item => typeof item === 'string' ? sanitizeUserText(item).clean.slice(0, 200) : item);
		}
	}
	return out;
}
