import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { en } from '../../src/lib/i18n/en.js';
import { de } from '../../src/lib/i18n/de.js';

const PLACEHOLDER_RE = /\{[a-zA-Z_][a-zA-Z0-9_]*\}/g;

function placeholders(s: string): Set<string> {
	return new Set((s.match(PLACEHOLDER_RE) ?? []).map(p => p.slice(1, -1)));
}

function setsEqual<T>(a: Set<T>, b: Set<T>): boolean {
	if (a.size !== b.size) return false;
	for (const v of a) if (!b.has(v)) return false;
	return true;
}

function loadJson(rel: string): Record<string, string> {
	return JSON.parse(readFileSync(path.resolve(rel), 'utf8'));
}

describe('i18n parity (en vs de)', () => {
	it('every English key has a German translation', () => {
		const missing = Object.keys(en).filter(k => !(k in de));
		expect(missing).toEqual([]);
	});

	it('every German key has an English translation', () => {
		const missing = Object.keys(de).filter(k => !(k in en));
		expect(missing).toEqual([]);
	});

	it('no value is empty', () => {
		const enEmpty = Object.entries(en).filter(([, v]) => !v).map(([k]) => k);
		const deEmpty = Object.entries(de).filter(([, v]) => !v).map(([k]) => k);
		expect({ enEmpty, deEmpty }).toEqual({ enEmpty: [], deEmpty: [] });
	});

	it('placeholder sets match per key', () => {
		const drift: Array<{ key: string; en: string[]; de: string[] }> = [];
		for (const k of Object.keys(en)) {
			if (!(k in de)) continue;
			const enP = placeholders(en[k]);
			const deP = placeholders(de[k]);
			if (!setsEqual(enP, deP)) {
				drift.push({ key: k, en: [...enP].sort(), de: [...deP].sort() });
			}
		}
		expect(drift).toEqual([]);
	});

	it('en is the canonical key set (no surprises in de)', () => {
		expect(Object.keys(de).sort()).toEqual(Object.keys(en).sort());
	});
});

describe('PDF templateStrings parity (en vs de)', () => {
	const tEn = loadJson('assets/templateStrings/en.json');
	const tDe = loadJson('assets/templateStrings/de.json');

	it('every English key has a German translation', () => {
		const missing = Object.keys(tEn).filter(k => !(k in tDe));
		expect(missing).toEqual([]);
	});

	it('every German key has an English translation', () => {
		const missing = Object.keys(tDe).filter(k => !(k in tEn));
		expect(missing).toEqual([]);
	});

	it('no value is empty', () => {
		const enEmpty = Object.entries(tEn).filter(([, v]) => !v).map(([k]) => k);
		const deEmpty = Object.entries(tDe).filter(([, v]) => !v).map(([k]) => k);
		expect({ enEmpty, deEmpty }).toEqual({ enEmpty: [], deEmpty: [] });
	});

	it('placeholder sets match per key', () => {
		const drift: Array<{ key: string; en: string[]; de: string[] }> = [];
		for (const k of Object.keys(tEn)) {
			if (!(k in tDe)) continue;
			const enP = placeholders(tEn[k]);
			const deP = placeholders(tDe[k]);
			if (!setsEqual(enP, deP)) {
				drift.push({ key: k, en: [...enP].sort(), de: [...deP].sort() });
			}
		}
		expect(drift).toEqual([]);
	});

	it('en is the canonical key set (no surprises in de)', () => {
		expect(Object.keys(tDe).sort()).toEqual(Object.keys(tEn).sort());
	});
});

// Static-extraction parity: every key referenced as `new ServiceError('...')`
// or `serverT(lang)('...')` in the source tree MUST exist in en.ts. Without
// this, a stray `throw new ServiceError('error.foo')` whose key isn't in the
// catalog surfaces to operators as the literal string `error.foo` (server.ts
// falls through to the bare key when missing).
//
// The grep-shape regexes here are deliberately permissive — a single quote
// followed by an `error.`/`success.`/etc. prefix. False positives are
// preferable to false negatives.
import { execSync } from 'node:child_process';

describe('i18n key references in source actually exist in en.ts', () => {
	function extractKeysFromGrep(pattern: string, extractor: RegExp): Set<string> {
		const out = new Set<string>();
		let raw = '';
		try {
			// Skip this test file itself (its docstrings include literal example
			// keys like `error.foo` that aren't meant to round-trip to en.ts).
			raw = execSync(
				`grep -RhoE --include='*.ts' --include='*.svelte' --exclude-dir=node_modules --exclude-dir=.svelte-kit --exclude='i18n-parity.test.ts' ${JSON.stringify(pattern)} src tests || true`,
				{ encoding: 'utf8', cwd: path.resolve('.') }
			);
		} catch {
			raw = '';
		}
		for (const m of raw.matchAll(extractor)) {
			const key = m[1];
			if (key) out.add(key);
		}
		return out;
	}

	it('every `new ServiceError(\'…\')` key is present in en.ts', () => {
		const found = extractKeysFromGrep(
			"new ServiceError\\('[^']+'",
			/new ServiceError\('([^']+)'/g
		);
		const missing = [...found].filter(k => !(k in en));
		expect(missing).toEqual([]);
	});

	it('every `serverT(lang)(\'…\')` key is present in en.ts', () => {
		const found = extractKeysFromGrep(
			"serverT\\([^)]*\\)\\('[^']+'",
			/serverT\([^)]*\)\('([^']+)'/g
		);
		const missing = [...found].filter(k => !(k in en));
		expect(missing).toEqual([]);
	});
});
