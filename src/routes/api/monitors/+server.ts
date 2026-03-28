import { json, error } from '@sveltejs/kit';
import type { RequestHandler } from './$types.js';
import { parseJsonBody, translateServiceError } from '$lib/server/request-utils.js';
import { monitorSchema } from '$lib/validators.js';
import { getMonitors, createMonitor, updateMonitor, deleteMonitor, toggleMonitor } from '$services/monitors.js';

export const GET: RequestHandler = async ({ locals }) => {
	if (!locals.user) throw error(401);
	return json(getMonitors());
};

export const POST: RequestHandler = async ({ request, locals }) => {
	if (!locals.user) throw error(401);

	const body = await parseJsonBody(request);
	const { action, ...data } = body as { action?: string; [key: string]: unknown };

	if (action && action !== 'update' && action !== 'delete' && action !== 'toggle') {
		throw error(400, 'Invalid action');
	}

	if (action === 'update') {
		const { id, ...updateData } = data as { id: string; [key: string]: unknown };
		if (typeof id !== 'string' || !id) throw error(400, 'Missing or invalid id');
		const result = monitorSchema.safeParse(updateData);
		if (!result.success) throw error(400, result.error.issues[0].message);
		const updated = updateMonitor(id, result.data, locals.user.id);
		if (!updated) throw error(404, 'Monitor not found');
		return json(updated);
	}

	if (action === 'delete') {
		const { id } = data as { id: string };
		if (typeof id !== 'string' || !id) throw error(400, 'Missing or invalid id');
		if (!deleteMonitor(id, locals.user.id)) throw error(404, 'Monitor not found');
		return json({ ok: true });
	}

	if (action === 'toggle') {
		const { id, enabled } = data as { id: string; enabled: boolean };
		if (typeof id !== 'string' || !id) throw error(400, 'Missing or invalid id');
		if (typeof enabled !== 'boolean') throw error(400, 'Missing enabled');
		if (!toggleMonitor(id, enabled, locals.user.id)) throw error(404, 'Monitor not found');
		return json({ ok: true });
	}

	// Default: create
	const result = monitorSchema.safeParse(data);
	if (!result.success) throw error(400, result.error.issues[0].message);
	try {
		const monitor = createMonitor(result.data, locals.user.id);
		return json(monitor, { status: 201 });
	} catch (e) {
		return translateServiceError(e);
	}
};
