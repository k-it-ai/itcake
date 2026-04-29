import { json, error } from '@sveltejs/kit';
import type { RequestHandler } from './$types.js';
import { handleActionPost, requireId } from '$lib/server/request-utils.js';
import { monitorSchema } from '$lib/validators.js';
import { getMonitors, createMonitor, updateMonitor, deleteMonitor, toggleMonitor } from '$services/monitors.js';

export const GET: RequestHandler = async ({ locals }) => {
	if (!locals.user) throw error(401);
	return json(getMonitors());
};

export const POST: RequestHandler = ({ request, locals }) =>
	handleActionPost(request, locals, {
		create: (data, userId) => {
			const result = monitorSchema.safeParse(data);
			if (!result.success) throw error(400, result.error.issues[0].message);
			return json(createMonitor(result.data, userId), { status: 201 });
		},
		actions: {
			// Update keeps the full-schema validation (no partial). Caller
			// must send a complete monitor payload — preserving prior
			// behavior; the route was never partial-PATCH-style.
			update: (data, userId) => {
				const id = requireId(data);
				const { id: _, ...rest } = data;
				const result = monitorSchema.safeParse(rest);
				if (!result.success) throw error(400, result.error.issues[0].message);
				const updated = updateMonitor(id, result.data, userId);
				if (!updated) throw error(404, 'Monitor not found');
				return json(updated);
			},
			delete: (data, userId) => {
				const id = requireId(data);
				if (!deleteMonitor(id, userId)) throw error(404, 'Monitor not found');
				return json({ ok: true });
			},
			toggle: (data, userId) => {
				const id = requireId(data);
				const enabled = data.enabled;
				if (typeof enabled !== 'boolean') throw error(400, 'Missing enabled');
				if (!toggleMonitor(id, enabled, userId)) throw error(404, 'Monitor not found');
				return json({ ok: true });
			}
		}
	});
