import { getChanges as getChangesFromDb } from '$lib/server/changes.js';
import type { Change } from '$lib/types.js';

export function getRecentChanges(limit = 50): Change[] {
	const safeLimit = Math.min(Math.max(1, limit), 500);
	return getChangesFromDb(safeLimit).map(({ hash: _hash, ...rest }) => rest);
}
