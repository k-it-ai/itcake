import { COLLECTOR_TABLES, type CollectorTable } from './collector-tables.js';
import type { AgentCollectorResult, CollectorResultKind } from '#lib/types.js';

const PATH_SEGMENT_RE = /^[a-zA-Z_][a-zA-Z0-9_]*$/;

export interface OsqueryRecord {
	name: string;
	hostIdentifier: string;
	calendarTime: string;
	unixTime: number;
	columns: string[];
	snapshot: Array<Record<string, unknown>>;
	action: 'snapshot';
	decorations: { hostname: string };
}

function readPath(payload: unknown, path: string | null): Record<string, unknown>[] {
	if (path === null) {
		return payload && typeof payload === 'object' ? [payload as Record<string, unknown>] : [];
	}
	let cursor: unknown = payload;
	for (const seg of path.split('.')) {
		if (!PATH_SEGMENT_RE.test(seg)) return [];
		if (!cursor || typeof cursor !== 'object') return [];
		cursor = (cursor as Record<string, unknown>)[seg];
	}
	if (!Array.isArray(cursor)) return [];
	return cursor.filter((x) => x && typeof x === 'object') as Record<string, unknown>[];
}

function extractByPath(row: Record<string, unknown>, path: string): unknown {
	let cursor: unknown = row;
	for (const seg of path.split('.')) {
		if (!cursor || typeof cursor !== 'object') return null;
		cursor = (cursor as Record<string, unknown>)[seg];
	}
	return cursor === undefined ? null : cursor;
}

function dataColumnsFor(table: CollectorTable) {
	return table.columns.filter((c) => c.path !== '__recorded_at__' && c.path !== '__command_id__');
}

export function formatOsquerySnapshot(
	snap: AgentCollectorResult,
	hostname: string
): OsqueryRecord {
	const table = COLLECTOR_TABLES[snap.kind];
	const dataColumns = dataColumnsFor(table);
	const rowsRaw = readPath(snap.payload, table.rowsPath);
	const projected = rowsRaw.map((r) => {
		const out: Record<string, unknown> = {};
		for (const col of dataColumns) out[col.name] = extractByPath(r, col.path);
		return out;
	});
	const unixTime = Math.floor(Date.parse(snap.recordedAt) / 1000);
	return {
		name: snap.kind,
		hostIdentifier: snap.agentId,
		calendarTime: snap.recordedAt,
		unixTime: Number.isFinite(unixTime) ? unixTime : 0,
		columns: dataColumns.map((c) => c.name),
		snapshot: projected,
		action: 'snapshot',
		decorations: { hostname }
	};
}

export function osqueryNdjson(snapshots: AgentCollectorResult[], hostname: string): string {
	const lines: string[] = [];
	for (const snap of snapshots) {
		lines.push(JSON.stringify(formatOsquerySnapshot(snap, hostname)));
	}
	return lines.join('\n') + (lines.length ? '\n' : '');
}

export function isQueryableCollectorKind(kind: string): kind is CollectorResultKind {
	return kind in COLLECTOR_TABLES;
}
