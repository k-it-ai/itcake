import { json, error } from '@sveltejs/kit';
import type { RequestHandler } from './$types.js';
import { handleActionPost, notFound, parseUpdateBody, requireId, requireUser } from '#lib/server/request-utils.js';
import { createInvoiceSchema, updateInvoiceSchema } from '#lib/validators.js';
import {
	getInvoices,
	getInvoicesByStatus,
	createInvoice,
	updateInvoice,
	removeInvoice,
	INVOICE_STATUSES
} from '#services/invoices.js';

export const GET: RequestHandler = async ({ locals, url }) => {
	requireUser(locals);

	const status = url.searchParams.get('status');
	if (status && !INVOICE_STATUSES.includes(status as typeof INVOICE_STATUSES[number])) throw error(400, 'Invalid status');
	const invoices = status ? getInvoicesByStatus(status as typeof INVOICE_STATUSES[number]) : getInvoices();

	return json(invoices);
};

export const POST: RequestHandler = ({ request, locals }) =>
	handleActionPost(request, locals, {
		create: (data, userId) => {
			const result = createInvoiceSchema.safeParse(data);
			if (!result.success) throw error(400, result.error.issues[0].message);
			return json(createInvoice(result.data, userId), { status: 201 });
		},
		actions: {
			update: (data, userId) => {
				const id = requireId(data);
				const { id: _, ...rest } = data;
				const safe = parseUpdateBody(updateInvoiceSchema, rest);
				const updated = updateInvoice(id, safe, userId);
				if (!updated) throw notFound();
				return json(updated);
			},
			delete: (data, userId) => {
				const id = requireId(data);
				if (!removeInvoice(id, userId)) throw notFound();
				return json({ ok: true });
			}
		}
	});
