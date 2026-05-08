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
