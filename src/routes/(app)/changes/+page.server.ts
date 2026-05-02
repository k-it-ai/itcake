import type { PageServerLoad } from './$types.js';
import { redirect } from '@sveltejs/kit';
import { getRecentChanges } from '$services/changes.js';
import { db } from '$lib/server/db.js';

export const load: PageServerLoad = async ({ locals }) => {
	if (!locals.user) throw redirect(302, '/login');

	const changes = getRecentChanges(500);

	const entityIds = [...new Set(changes.map(c => c.entityId))];
	const entityLabels: Record<string, string> = {};
	if (entityIds.length > 0) {
		const placeholders = entityIds.map(() => '?').join(',');
		const rows = db.prepare(`
			SELECT id,
				COALESCE(json_extract(data, '$.documentId'), json_extract(data, '$.clientNumber'), json_extract(data, '$.name'), id) as label
			FROM documents WHERE id IN (${placeholders})
		`).all(...entityIds) as { id: string; label: string }[];
		for (const row of rows) {
			entityLabels[row.id] = row.label;
		}
	}

	return { changes, entityLabels };
};
