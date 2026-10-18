import { getChanges as getChangesFromDb, getChangesPage as getChangesPageFromDb, countChanges } from '#lib/server/changes.js';
import type { Change } from '#lib/types.js';

export function getRecentChanges(limit = 50): Change[] {
	const safeLimit = Math.min(Math.max(1, limit), 500);
	return getChangesFromDb(safeLimit).map(({ hash: _hash, ...rest }) => rest);
}

export function getChangesPage(
	page = 1,
	pageSize = 50,
	dir: 'asc' | 'desc' = 'desc'
): { changes: Change[]; total: number; page: number; pageSize: number } {
	const safeSize = Math.min(Math.max(1, pageSize), 200);
	const safePage = Math.max(1, page);
	const total = countChanges();
	const changes = getChangesPageFromDb(safeSize, (safePage - 1) * safeSize, dir)
		.map(({ hash: _hash, ...rest }) => rest);
	return { changes, total, page: safePage, pageSize: safeSize };
}
