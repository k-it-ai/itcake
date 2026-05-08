import { db } from '$lib/server/db.js';
import { compileFilter, type FilterCondition } from '$lib/server/filter-engine.js';
import { COLLECTOR_TABLES, fieldsForKind } from '$lib/server/collector-tables.js';
import type { CollectorResultKind } from '$lib/types.js';

const PATH_SEGMENT_RE = /^[a-zA-Z_][a-zA-Z0-9_]*$/;

const MAX_LIMIT = 200;
const DEFAULT_LIMIT = 50;

export interface CollectorQueryInput {
	agentId: string;
	kind: CollectorResultKind;
	where?: FilterCondition[];
	columns?: string[];
	limit?: number;
}

export interface CollectorQueryResult {
	kind: CollectorResultKind;
	rowsPath: string | null;
	total: number;
	rows: Array<Record<string, unknown>>;
}

function safePath(path: string): string {
	for (const seg of path.split('.')) {
		if (!PATH_SEGMENT_RE.test(seg)) {
			throw new Error(`collector-query: rejected path segment "${seg}"`);
		}
	}
	return path;
}

export function queryCollectorResults(input: CollectorQueryInput): CollectorQueryResult {
	const table = COLLECTOR_TABLES[input.kind];
	if (!table) throw new Error(`collector-query: unknown kind "${input.kind}"`);

	const limit = Math.min(MAX_LIMIT, Math.max(1, input.limit ?? DEFAULT_LIMIT));

	const fields = fieldsForKind(input.kind);
	const compiled = compileFilter(input.where ?? [], fields);

	const requested = input.columns?.length ? input.columns : table.columns.map((c) => c.name);
	for (const c of requested) {
		if (!fields.has(c)) {
			throw new Error(`collector-query: unknown column "${c}" for kind "${input.kind}"`);
		}
	}

	const selectParts = requested.map((c) => {
		const f = fields.get(c)!;
		return `${f.column} as "${c}"`;
	}).join(', ');

	const baseParams: unknown[] = [input.agentId, input.kind, ...compiled.params, limit];

	let sql: string;
	if (table.rowsPath) {
		const path = safePath(table.rowsPath);
		sql =
			`SELECT ${selectParts} ` +
			`FROM agent_collector_results r, json_each(json_extract(r.payload, '$.${path}')) j ` +
			`WHERE r.agent_id = ? AND r.kind = ? AND ${compiled.sql} ` +
			`ORDER BY r.recorded_at DESC, j.key ASC ` +
			`LIMIT ?`;
	} else {
		sql =
			`SELECT ${selectParts} ` +
			`FROM agent_collector_results r ` +
			`WHERE r.agent_id = ? AND r.kind = ? AND ${compiled.sql} ` +
			`ORDER BY r.recorded_at DESC ` +
			`LIMIT ?`;
	}

	const rows = db.prepare(sql).all(...baseParams) as Array<Record<string, unknown>>;
	return {
		kind: input.kind,
		rowsPath: table.rowsPath,
		total: rows.length,
		rows
	};
}
