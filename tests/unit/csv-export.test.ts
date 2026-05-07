import { describe, it, expect } from 'vitest';
import { rowsToCsv, csvResponseHeaders } from '../../src/lib/server/csv.js';

describe('rowsToCsv (RFC 4180 + Excel BOM)', () => {
	it('emits header row + UTF-8 BOM + CRLF line endings', () => {
		const csv = rowsToCsv([{ a: '1', b: '2' }], [
			{ key: 'a', header: 'Alpha' },
			{ key: 'b', header: 'Beta' }
		]);
		expect(csv.charCodeAt(0)).toBe(0xFEFF);
		expect(csv.includes('Alpha,Beta\r\n')).toBe(true);
		expect(csv.endsWith('1,2\r\n')).toBe(true);
	});

	it('quotes cells containing comma, quote, CR, LF, leading/trailing space', () => {
		const csv = rowsToCsv(
			[{ a: 'foo,bar', b: 'has "quote"', c: 'line\nbreak', d: ' spaced ' }],
			[
				{ key: 'a', header: 'A' },
				{ key: 'b', header: 'B' },
				{ key: 'c', header: 'C' },
				{ key: 'd', header: 'D' }
			]
		);
		expect(csv).toContain('"foo,bar"');
		expect(csv).toContain('"has ""quote"""');
		expect(csv).toContain('"line\nbreak"');
		expect(csv).toContain('" spaced "');
	});

	it('serialises objects/arrays as JSON, dates as ISO, null/undefined as empty', () => {
		const csv = rowsToCsv(
			[{ a: { x: 1 }, b: [1, 2], c: new Date('2026-01-15T10:00:00Z'), d: null, e: undefined }],
			[
				{ key: 'a', header: 'obj' },
				{ key: 'b', header: 'arr' },
				{ key: 'c', header: 'date' },
				{ key: 'd', header: 'null' },
				{ key: 'e', header: 'undef' }
			]
		);
		const lines = csv.split('\r\n');
		expect(lines[1]).toBe('"{""x"":1}","[1,2]",2026-01-15T10:00:00.000Z,,');
	});

	it('header row with no data still has trailing CRLF', () => {
		const csv = rowsToCsv([], [{ key: 'a', header: 'A' }]);
		expect(csv).toBe('﻿A\r\n');
	});

	it('neutralises Excel/Numbers formula injection (=,+,-,@,TAB,CR)', () => {
		// SECURITY (sec-review C2): a finding title / agent name / audit
		// content controlled by anything that ends up in a CSV must not
		// execute as a spreadsheet formula on open.
		const csv = rowsToCsv(
			[
				{ a: '=cmd|/c calc!A0' },
				{ a: '+SUM(A1)' },
				{ a: '-1+1' },
				{ a: '@xss' },
				{ a: '\tlead-tab' },
				{ a: '\rlead-cr' },
				{ a: 'normal' }
			],
			[{ key: 'a', header: 'A' }]
		);
		const lines = csv.split('\r\n');
		// Each formula-trigger row should be quoted (because of the leading
		// single-quote prefix interacting with separator/CR rules) and
		// contain a literal `'` immediately before the dangerous character.
		expect(lines[1]).toContain(`'=cmd|/c calc!A0`);
		expect(lines[2]).toContain(`'+SUM(A1)`);
		expect(lines[3]).toContain(`'-1+1`);
		expect(lines[4]).toContain(`'@xss`);
		expect(lines[5]).toContain(`'\tlead-tab`);
		expect(lines[6]).toContain(`'\rlead-cr`);
		// Plain text is unchanged.
		expect(lines[7]).toBe('normal');
	});

	it('csvResponseHeaders sanitises filename and forces no-store', () => {
		const h = csvResponseHeaders('weird name/../etc/passwd.csv') as Record<string, string>;
		expect(h['Content-Type']).toBe('text/csv; charset=utf-8');
		const m = h['Content-Disposition'].match(/filename="([^"]+)"/);
		expect(m).not.toBeNull();
		const fname = m![1];
		// Path separators and spaces inside the filename are stripped to underscores.
		expect(fname).not.toContain('/');
		expect(fname).not.toContain('\\');
		expect(fname).not.toContain(' ');
		expect(fname).toMatch(/^[a-zA-Z0-9._-]+$/);
		expect(h['Cache-Control']).toBe('no-store');
	});
});
