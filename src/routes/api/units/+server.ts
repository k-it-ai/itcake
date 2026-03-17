import { json, error } from '@sveltejs/kit';
import type { RequestHandler } from './$types.js';
import { parseJsonBody, translateServiceError } from '$lib/server/request-utils.js';
import { unitSchema } from '$lib/validators.js';
import { getUnits, createUnit, updateUnit, removeUnit } from '$services/units.js';

export const GET: RequestHandler = async ({ locals }) => {
	if (!locals.user) throw error(401);
	return json(getUnits());
};

export const POST: RequestHandler = async ({ request, locals }) => {
	if (!locals.user) throw error(401);

	const body = await parseJsonBody(request);
	const { action, ...data } = body as { action?: string; [key: string]: unknown };

	if (action && action !== 'update' && action !== 'delete') {
		throw error(400, 'Invalid action');
	}

	if (action === 'update') {
		const { id, name } = data as { id: string; name: string };
		if (typeof id !== 'string' || !id) throw error(400, 'Missing or invalid id');
		const result = unitSchema.safeParse({ name });
		if (!result.success) throw error(400, result.error.issues[0].message);
		try {
			const updated = updateUnit(id, result.data.name, locals.user.id);
			if (!updated) throw error(404, 'Unit not found');
			return json(updated);
		} catch (e) { return translateServiceError(e); }
	}

	if (action === 'delete') {
		const { id } = data as { id: string };
		if (typeof id !== 'string' || !id) throw error(400, 'Missing or invalid id');
		try {
			if (!removeUnit(id, locals.user.id)) throw error(404, 'Unit not found');
			return json({ ok: true });
		} catch (e) { return translateServiceError(e); }
	}

	const result = unitSchema.safeParse(data);
	if (!result.success) throw error(400, result.error.issues[0].message);
	try {
		return json(createUnit(result.data.name, locals.user.id), { status: 201 });
	} catch (e) { return translateServiceError(e); }
};
