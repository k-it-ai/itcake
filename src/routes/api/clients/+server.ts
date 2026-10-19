import { json, error } from '@sveltejs/kit';
import type { RequestHandler } from './$types.js';
import { handleActionPost, notFound, parseUpdateBody, requireId, requireUser } from '#lib/server/request-utils.js';
import { clientSchema } from '#lib/validators.js';
import { getClients, createClient, updateClient, removeClient } from '#services/clients.js';

export const GET: RequestHandler = async ({ locals }) => {
	requireUser(locals);
	return json(getClients());
};

export const POST: RequestHandler = ({ request, locals }) =>
	handleActionPost(request, locals, {
		create: (data, userId) => {
			const result = clientSchema.safeParse(data);
			if (!result.success) throw error(400, result.error.issues[0].message);
			return json(createClient(result.data, userId), { status: 201 });
		},
		actions: {
			update: (data, userId) => {
				const id = requireId(data);
				const { id: _, ...rest } = data;
				const safe = parseUpdateBody(clientSchema.partial(), rest);
				const updated = updateClient(id, safe, userId);
				if (!updated) throw notFound();
				return json(updated);
			},
			delete: (data, userId) => {
				const id = requireId(data);
				const result = removeClient(id, userId);
				if (!result.ok) throw error(result.error === 'Client not found' ? 404 : 400, result.error ?? 'Delete failed');
				return json({ ok: true });
			}
		}
	});
