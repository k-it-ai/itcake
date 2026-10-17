import { json, error } from '@sveltejs/kit';
import type { RequestHandler } from './$types.js';
import { handleActionPost, requireUser, requireId } from '#lib/server/request-utils.js';
import { listSavedFilters, createSavedFilter, updateSavedFilter, deleteSavedFilter } from '#services/saved-filters.js';

export const GET: RequestHandler = async ({ locals, url }) => {
	requireUser(locals);
	const appliesTo = url.searchParams.get('appliesTo') ?? undefined;
	return json(listSavedFilters(appliesTo ?? undefined));
};

export const POST: RequestHandler = ({ request, locals }) =>
	handleActionPost(request, locals, {
		create: (data, userId) => json(createSavedFilter(data as never, userId)),
		actions: {
			update: (data, userId) => {
				const id = requireId(data);
				const { id: _, ...rest } = data as { id: string } & Record<string, unknown>;
				const updated = updateSavedFilter(id, rest as never, userId);
				if (!updated) throw error(404, 'Not found');
				return json(updated);
			},
			delete: (data, userId) => {
				const id = requireId(data);
				if (!deleteSavedFilter(id, userId)) throw error(404, 'Not found');
				return json({ ok: true });
			}
		}
	});
