import { json, error } from '@sveltejs/kit';
import type { RequestHandler } from './$types.js';
import { parseJsonBody, translateServiceError } from '$lib/server/request-utils.js';
import { updateInvoiceStatus, INVOICE_STATUSES } from '$services/invoices.js';
import type { InvoiceStatus } from '$lib/types.js';

export const POST: RequestHandler = async ({ params, request, locals }) => {
	if (!locals.user) throw error(401);

	const body = await parseJsonBody(request);
	const { status } = body as { status: string };

	if (!INVOICE_STATUSES.includes(status as InvoiceStatus)) throw error(400, 'Invalid status');

	try {
		const updated = updateInvoiceStatus(
			params.id,
			status as InvoiceStatus,
			locals.user.id
		);
		if (!updated) throw error(404, 'Invoice not found');
		return json({ ok: true, status: updated.status });
	} catch (e) {
		return translateServiceError(e);
	}
};
