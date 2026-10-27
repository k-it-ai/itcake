import { json, error } from '@sveltejs/kit';
import type { RequestHandler } from './$types.js';
import { handleActionPost, notFound, requireId, requireAdmin } from '#lib/server/request-utils.js';
import { unitSchema } from '#lib/validators.js';
import { getUnits, createUnit, updateUnit, removeUnit } from '#services/units.js';

export const GET: RequestHandler = async ({ locals }) => {
	requireAdmin(locals);
	return json(getUnits());
};

export const POST: RequestHandler = ({ request, locals }) =>
	handleActionPost(request, locals, {
		create: (data, userId) => {
			const result = unitSchema.safeParse(data);
			if (!result.success) throw error(400, result.error.issues[0].message);
			return json(createUnit(result.data.name, userId), { status: 201 });
		},
		actions: {
			update: (data, userId) => {
				const id = requireId(data);
				const result = unitSchema.safeParse({ name: data.name });
				if (!result.success) throw error(400, result.error.issues[0].message);
				const updated = updateUnit(id, result.data.name, userId);
				if (!updated) throw notFound();
				return json(updated);
			},
			delete: (data, userId) => {
				const id = requireId(data);
				if (!removeUnit(id, userId)) throw notFound();
				return json({ ok: true });
			}
		}
	});
