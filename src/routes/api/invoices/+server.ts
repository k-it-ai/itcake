import { json, error } from '@sveltejs/kit';
import type { RequestHandler } from './$types.js';
import { parseJsonBody, translateServiceError, pickPresentKeys } from '$lib/server/request-utils.js';
import { createInvoiceSchema, updateInvoiceSchema } from '$lib/validators.js';
import {
	getInvoices,
	getInvoicesByStatus,
	createInvoice,
	updateInvoice,
	removeInvoice,
	INVOICE_STATUSES
} from '$services/invoices.js';

export const GET: RequestHandler = async ({ locals, url }) => {
	if (!locals.user) throw error(401);

	const status = url.searchParams.get('status');
	if (status && !INVOICE_STATUSES.includes(status as typeof INVOICE_STATUSES[number])) throw error(400, 'Invalid status');
	const invoices = status ? getInvoicesByStatus(status as typeof INVOICE_STATUSES[number]) : getInvoices();

	return json(invoices);
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
		const validated = updateInvoiceSchema.safeParse(updateData);
		if (!validated.success) throw error(400, validated.error.issues[0].message);
		const safeData = pickPresentKeys(validated.data, updateData);
		delete (safeData as Record<string, unknown>).status;
		try {
			const updated = updateInvoice(id, safeData, locals.user.id);
			if (!updated) throw error(404, 'Invoice not found');
			return json(updated);
		} catch (e) { return translateServiceError(e); }
	}

	if (action === 'delete') {
		const { id } = data as { id: string };
		if (typeof id !== 'string' || !id) throw error(400, 'Missing or invalid id');
		try {
			const removed = removeInvoice(id, locals.user.id);
			if (!removed) throw error(404, 'Invoice not found');
			return json({ ok: true });
		} catch (e) { return translateServiceError(e); }
	}

	// Default: create
	const result = createInvoiceSchema.safeParse(data);
	if (!result.success) throw error(400, result.error.issues[0].message);
	try {
		const invoice = createInvoice(result.data, locals.user.id);
		return json(invoice, { status: 201 });
	} catch (e) { return translateServiceError(e); }
};
