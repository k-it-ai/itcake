const FIELD_SEPARATOR = ',';
const RECORD_SEPARATOR = '\r\n';
const QUOTE = '"';

function needsQuoting(s: string): boolean {
	if (s.length === 0) return false;
	if (s.includes(FIELD_SEPARATOR) || s.includes(QUOTE) || s.includes('\n') || s.includes('\r')) return true;
	if (s.startsWith(' ') || s.endsWith(' ')) return true;
	return false;
}

// Spreadsheet apps treat leading =/+/-/@/TAB/CR as formula triggers; prefix
// with `'` to force text on open.
function neutraliseFormula(s: string): string {
	if (s.length > 0 && /^[=+\-@\t\r]/.test(s)) return "'" + s;
	return s;
}

function escapeCell(value: unknown): string {
	if (value === null || value === undefined) return '';
	let s: string;
	if (value instanceof Date) {
		s = value.toISOString();
	} else if (typeof value === 'object') {
		try { s = JSON.stringify(value); } catch { s = String(value); }
	} else {
		s = String(value);
	}
	s = neutraliseFormula(s);
	if (needsQuoting(s)) return QUOTE + s.replace(/"/g, '""') + QUOTE;
	return s;
}

export function rowsToCsv<T extends Record<string, unknown>>(
	rows: T[],
	columns: ReadonlyArray<{ key: keyof T & string; header: string }>
): string {
	const out: string[] = [];
	out.push(columns.map(c => escapeCell(c.header)).join(FIELD_SEPARATOR));
	for (const r of rows) {
		out.push(columns.map(c => escapeCell(r[c.key])).join(FIELD_SEPARATOR));
	}
	return '﻿' + out.join(RECORD_SEPARATOR) + RECORD_SEPARATOR;
}

export function csvResponseHeaders(filename: string): HeadersInit {
	const safe = filename.replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 200);
	return {
		'Content-Type': 'text/csv; charset=utf-8',
		'Content-Disposition': `attachment; filename="${safe}"`,
		'Cache-Control': 'no-store'
	};
}
