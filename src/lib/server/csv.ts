/**
 * RFC 4180 CSV writer with the Excel-friendly UTF-8 BOM.
 *
 * - escapes any cell containing the field separator, quotation mark, CR, LF, or leading/trailing whitespace
 * - serialises arrays as JSON, objects as JSON, dates via toISOString, null/undefined as empty string
 * - prepends ﻿ so Excel opens UTF-8 properly without dropping European chars
 */

const FIELD_SEPARATOR = ',';
const RECORD_SEPARATOR = '\r\n';
const QUOTE = '"';

function needsQuoting(s: string): boolean {
	if (s.length === 0) return false;
	if (s.includes(FIELD_SEPARATOR) || s.includes(QUOTE) || s.includes('\n') || s.includes('\r')) return true;
	if (s.startsWith(' ') || s.endsWith(' ')) return true;
	return false;
}

// Excel/Numbers/LibreOffice treat a leading =, +, -, @, TAB or CR as a formula
// trigger when the file is opened. Prefix with a single quote so the cell is
// rendered as text. The leading single quote then forces quoting (because the
// cell now starts with a non-alphanumeric whose interaction with separator/CR
// rules is best avoided), so we route through needsQuoting either way.
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
