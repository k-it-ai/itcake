import { json, error } from '@sveltejs/kit';
import type { RequestHandler } from './$types.js';
import { handleActionPost, notFound, parseUpdateBody, requireId, requireUser } from '#lib/server/request-utils.js';
import { catalogItemSchema } from '#lib/validators.js';
import {
	getCatalogItems,
	createCatalogItem,
	updateCatalogItem,
	removeCatalogItem
} from '#services/catalog-items.js';

export const GET: RequestHandler = async ({ locals }) => {
	requireUser(locals);
	return json(getCatalogItems());
};

export const POST: RequestHandler = ({ request, locals }) =>
	handleActionPost(request, locals, {
		create: (data, userId) => {
			const result = catalogItemSchema.safeParse(data);
			if (!result.success) throw error(400, result.error.issues[0].message);
			return json(createCatalogItem(result.data, userId), { status: 201 });
		},
		actions: {
			update: (data, userId) => {
				const id = requireId(data);
				const { id: _, ...rest } = data;
				const safe = parseUpdateBody(catalogItemSchema.partial(), rest);
				const updated = updateCatalogItem(id, safe, userId);
				if (!updated) throw notFound();
				return json(updated);
			},
			delete: (data, userId) => {
				const id = requireId(data);
				if (!removeCatalogItem(id, userId)) throw notFound();
				return json({ ok: true });
			}
		}
	});
