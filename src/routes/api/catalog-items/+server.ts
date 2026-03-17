import { json, error } from '@sveltejs/kit';
import type { RequestHandler } from './$types.js';
import { parseJsonBody, translateServiceError } from '$lib/server/request-utils.js';
import { catalogItemSchema } from '$lib/validators.js';
import {
	getCatalogItems,
	createCatalogItem,
	updateCatalogItem,
	removeCatalogItem
} from '$services/catalog-items.js';

export const GET: RequestHandler = async ({ locals }) => {
	if (!locals.user) throw error(401);
	return json(getCatalogItems());
};

export const POST: RequestHandler = async ({ request, locals }) => {
	if (!locals.user) throw error(401);

	const body = await parseJsonBody(request);
	const { action, ...data } = body as { action?: string; [key: string]: unknown };

	if (action && action !== 'update' && action !== 'delete') {
		throw error(400, 'Invalid action');
	}

	if (action === 'update') {
		const { id, ...updateData } = data as { id: string; [key: string]: unknown };
		if (typeof id !== 'string' || !id) throw error(400, 'Missing or invalid id');
		const result = catalogItemSchema.partial().safeParse(updateData);
		if (!result.success) throw error(400, result.error.issues[0].message);
		try {
			const updated = updateCatalogItem(id, result.data, locals.user.id);
			if (!updated) throw error(404, 'Catalog item not found');
			return json(updated);
		} catch (e) { return translateServiceError(e); }
	}

	if (action === 'delete') {
		const { id } = data as { id: string };
		if (typeof id !== 'string' || !id) throw error(400, 'Missing or invalid id');
		try {
			if (!removeCatalogItem(id, locals.user.id)) throw error(404, 'Catalog item not found');
			return json({ ok: true });
		} catch (e) { return translateServiceError(e); }
	}

	const result = catalogItemSchema.safeParse(data);
	if (!result.success) throw error(400, result.error.issues[0].message);
	try {
		return json(createCatalogItem(result.data, locals.user.id), { status: 201 });
	} catch (e) { return translateServiceError(e); }
};
