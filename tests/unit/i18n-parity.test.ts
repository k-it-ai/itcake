import { describe, it, expect } from 'vitest';
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
