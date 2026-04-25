import { json, error } from '@sveltejs/kit';
import type { RequestHandler } from './$types.js';
import { parseJsonBody, translateServiceError, pickPresentKeys } from '$lib/server/request-utils.js';
import { clientSchema } from '$lib/validators.js';
import { getClients, createClient, updateClient, removeClient } from '$services/clients.js';

export const GET: RequestHandler = async ({ locals }) => {
	if (!locals.user) throw error(401);
	return json(getClients());
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
		const result = clientSchema.partial().safeParse(updateData);
		if (!result.success) throw error(400, result.error.issues[0].message);
		const safeData = pickPresentKeys(result.data, updateData);
		try {
			const updated = updateClient(id, safeData, locals.user.id);
			if (!updated) throw error(404, 'Client not found');
			return json(updated);
		} catch (e) { return translateServiceError(e); }
	}

	if (action === 'delete') {
		const { id } = data as { id: string };
		if (typeof id !== 'string' || !id) throw error(400, 'Missing or invalid id');
		try {
			const result = removeClient(id, locals.user.id);
			if (!result.ok) throw error(result.error === 'Client not found' ? 404 : 400, result.error ?? 'Delete failed');
			return json({ ok: true });
		} catch (e) { return translateServiceError(e); }
	}

	// Default: create
	const result = clientSchema.safeParse(data);
	if (!result.success) throw error(400, result.error.issues[0].message);
	try {
		const client = createClient(result.data, locals.user.id);
		return json(client, { status: 201 });
	} catch (e) { return translateServiceError(e); }
};
