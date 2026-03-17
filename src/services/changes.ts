import { getChanges as getChangesFromDb } from '$lib/server/changes.js';
import type { Change } from '$lib/types.js';

export function getRecentChanges(limit = 50): Change[] {
	const safeLimit = Math.min(Math.max(1, limit), 500);
	const changes = getChangesFromDb(safeLimit);
	return changes.map((c) => ({
		id: c.id,
		entityType: c.entityType as Change['entityType'],
		entityId: c.entityId,
		action: c.action as Change['action'],
		diff: c.diff,
		userId: c.userId,
		createdAt: c.createdAt
	}));
}

