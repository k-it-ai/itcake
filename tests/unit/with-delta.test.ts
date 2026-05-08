import { describe, it, expect } from 'vitest';
import { withDelta } from '../../src/lib/server/with-delta.js';

interface Row {
	id: string;
	name: string;
	value: number;
}

const keyOf = (r: Row) => r.id;

describe('withDelta', () => {
	it('classifies pure additions when prev is empty', () => {
		const r = withDelta<Row>([], [{ id: 'a', name: 'A', value: 1 }], { keyOf });
		expect(r.added.map(x => x.id)).toEqual(['a']);
		expect(r.removed).toEqual([]);
		expect(r.changed).toEqual([]);
	});

	it('classifies pure removals when current is empty', () => {
		const r = withDelta<Row>([{ id: 'a', name: 'A', value: 1 }], [], { keyOf });
		expect(r.removed.map(x => x.id)).toEqual(['a']);
		expect(r.added).toEqual([]);
	});

	it('treats matching keys as unchanged when no changeFields are configured', () => {
		const prev = [{ id: 'a', name: 'A', value: 1 }];
		const cur = [{ id: 'a', name: 'B', value: 9 }];
		const r = withDelta<Row>(prev, cur, { keyOf });
		expect(r.changed).toEqual([]);
		expect(r.unchanged.map(x => x.id)).toEqual(['a']);
	});

	it('records reasons when a change-field equality fails', () => {
		const prev = [{ id: 'a', name: 'A', value: 1 }];
		const cur = [{ id: 'a', name: 'B', value: 9 }];
		const r = withDelta<Row>(prev, cur, {
			keyOf,
			changeFields: [
				{ name: 'name', equals: (a, b) => a.name === b.name },
				{ name: 'value', equals: (a, b) => a.value === b.value }
			]
		});
		expect(r.changed).toHaveLength(1);
		expect(r.changed[0].reasons.sort()).toEqual(['name', 'value']);
	});

	it('separates added/removed/changed/unchanged in one pass', () => {
		const prev: Row[] = [
			{ id: 'a', name: 'A', value: 1 },
			{ id: 'b', name: 'B', value: 2 },
			{ id: 'c', name: 'C', value: 3 }
		];
		const cur: Row[] = [
			{ id: 'a', name: 'A', value: 1 },
			{ id: 'b', name: 'B-new', value: 2 },
			{ id: 'd', name: 'D', value: 4 }
		];
		const r = withDelta<Row>(prev, cur, {
			keyOf,
			changeFields: [{ name: 'name', equals: (a, b) => a.name === b.name }]
		});
		expect(r.added.map(x => x.id)).toEqual(['d']);
		expect(r.removed.map(x => x.id)).toEqual(['c']);
		expect(r.changed.map(x => x.current.id)).toEqual(['b']);
		expect(r.unchanged.map(x => x.id)).toEqual(['a']);
	});

	it('uses the provided keyOf so callers can dedupe by composite key', () => {
		const prev = [
			{ id: '1', name: 'foo', value: 0 },
			{ id: '2', name: 'foo', value: 0 }
		];
		const cur = [
			{ id: '1', name: 'foo', value: 0 },
			{ id: '3', name: 'foo', value: 0 }
		];
		const r = withDelta(prev, cur, { keyOf: (r: Row) => `${r.id}:${r.name}` });
		expect(r.added.map(x => x.id)).toEqual(['3']);
		expect(r.removed.map(x => x.id)).toEqual(['2']);
	});
});
