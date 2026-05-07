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

// Conservative Cyrillic/Greek → Latin fold so homoglyphs match the injection
// regex. Only used for matching; the returned `clean` text keeps original glyphs.
const CONFUSABLE_FOLDS: Record<string, string> = {
	// Cyrillic → Latin
	'а': 'a', 'е': 'e', 'о': 'o', 'р': 'p', 'с': 'c', 'у': 'y', 'х': 'x', 'і': 'i', 'ѕ': 's', 'ј': 'j', 'ԁ': 'd', 'ɡ': 'g',
	'А': 'A', 'В': 'B', 'Е': 'E', 'К': 'K', 'М': 'M', 'Н': 'H', 'О': 'O', 'Р': 'P', 'С': 'C', 'Т': 'T', 'Х': 'X', 'І': 'I',
	// Greek → Latin
	'α': 'a', 'ο': 'o', 'ρ': 'p', 'υ': 'y', 'ν': 'v', 'ι': 'i', 'τ': 't',
	'Α': 'A', 'Β': 'B', 'Ε': 'E', 'Ζ': 'Z', 'Η': 'H', 'Ι': 'I', 'Κ': 'K', 'Μ': 'M', 'Ν': 'N', 'Ο': 'O', 'Ρ': 'P', 'Τ': 'T', 'Υ': 'Y', 'Χ': 'X'
};

function foldForMatching(s: string): string {
	let out = s.normalize('NFKC');
	out = out.replace(/[-￿]/g, ch => CONFUSABLE_FOLDS[ch] ?? ch);
	return out;
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
	const matchTarget = foldForMatching(clean);
	for (const re of INJECTION_PATTERNS) {
		if (re.test(matchTarget) || re.test(clean)) {
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

const MAX_PC_DEPTH = 4;
const MAX_PC_STRING = 1000;
const MAX_PC_ARRAY = 50;

function sanitizePageValue(v: unknown, depth: number): unknown {
	if (depth > MAX_PC_DEPTH) return undefined;
	if (v === null || v === undefined) return v;
	if (typeof v === 'string') {
		const r = sanitizeUserText(v);
		return r.rejected ? undefined : r.clean.slice(0, MAX_PC_STRING);
	}
	if (typeof v === 'number' || typeof v === 'boolean') return v;
	if (Array.isArray(v)) {
		const out: unknown[] = [];
		for (const item of v.slice(0, MAX_PC_ARRAY)) {
			const sanitized = sanitizePageValue(item, depth + 1);
			if (sanitized !== undefined) out.push(sanitized);
		}
		return out;
	}
	if (typeof v === 'object') {
		const out: Record<string, unknown> = {};
		for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
			const sanitized = sanitizePageValue(val, depth + 1);
			if (sanitized !== undefined) out[k] = sanitized;
		}
		return out;
	}
	return undefined;
}

export function sanitizePageContext(ctx: unknown): Record<string, unknown> {
	if (!ctx || typeof ctx !== 'object') return {};
	const out: Record<string, unknown> = {};
	for (const [k, v] of Object.entries(ctx as Record<string, unknown>)) {
		const sanitized = sanitizePageValue(v, 1);
		if (sanitized !== undefined) out[k] = sanitized;
	}
	return out;
}
