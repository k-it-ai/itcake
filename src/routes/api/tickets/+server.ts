import { json, error } from '@sveltejs/kit';
import type { RequestHandler } from './$types.js';
import { parseJsonBody, translateServiceError } from '$lib/server/request-utils.js';
import { createTicketSchema, updateTicketSchema } from '$lib/validators.js';
import {
	getTickets,
	getTicketsByStatus,
	getTicketsByClient,
	getTicketsByDateRange,
	createTicket,
	updateTicket,
	updateTicketStatus,
	removeTicket,
	convertTicketToInvoice
} from '$services/tickets.js';
import type { TicketStatus } from '$lib/types.js';

const VALID_STATUSES: TicketStatus[] = ['open', 'completed', 'invoiced'];
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export const GET: RequestHandler = async ({ url, locals }) => {
	if (!locals.user) throw error(401);

	const status = url.searchParams.get('status');
	const clientId = url.searchParams.get('client');
	const from = url.searchParams.get('from');
	const to = url.searchParams.get('to');

	if (from && to) {
		if (!DATE_RE.test(from) || !DATE_RE.test(to)) throw error(400, 'Invalid date format (expected YYYY-MM-DD)');
		if (from > to) throw error(400, 'from must not be after to');
		return json(getTicketsByDateRange(from, to));
	}
	if (status && VALID_STATUSES.includes(status as TicketStatus)) {
		return json(getTicketsByStatus(status as TicketStatus));
	}
	if (clientId) {
		return json(getTicketsByClient(clientId));
	}
	return json(getTickets());
};

export const POST: RequestHandler = async ({ request, locals }) => {
	if (!locals.user) throw error(401);

	const body = await parseJsonBody(request);
	const { action, ...data } = body as { action?: string; [key: string]: unknown };

	if (action && !['update', 'delete', 'status', 'toInvoice'].includes(action)) {
		throw error(400, 'Invalid action');
	}

	try {
		if (action === 'update') {
			const { id, ...updateData } = data as { id: string; [key: string]: unknown };
			if (typeof id !== 'string' || !id) throw error(400, 'Missing or invalid id');
			const result = updateTicketSchema.safeParse(updateData);
			if (!result.success) throw error(400, result.error.issues[0].message);
			const updated = updateTicket(id, result.data, locals.user.id);
			if (!updated) throw error(404, 'Ticket not found');
			return json(updated);
		}

		if (action === 'delete') {
			const { id } = data as { id: string };
			if (typeof id !== 'string' || !id) throw error(400, 'Missing or invalid id');
			if (!removeTicket(id, locals.user.id)) throw error(404, 'Ticket not found');
			return json({ ok: true });
		}

		if (action === 'status') {
			const { id, status } = data as { id: string; status: string };
			if (typeof id !== 'string' || !id) throw error(400, 'Missing or invalid id');
			if (!VALID_STATUSES.includes(status as TicketStatus)) throw error(400, 'Invalid status');
			const updated = updateTicketStatus(id, status as TicketStatus, locals.user.id);
			if (!updated) throw error(404, 'Ticket not found');
			return json(updated);
		}

		if (action === 'toInvoice') {
			const { id, mode, invoiceId } = data as { id: string; mode: string; invoiceId?: string };
			if (typeof id !== 'string' || !id) throw error(400, 'Missing or invalid id');
			if (mode !== 'new' && mode !== 'existing') throw error(400, 'Invalid mode');
			const invoice = convertTicketToInvoice(id, { mode, invoiceId }, locals.user.id);
			return json(invoice, { status: 201 });
		}

		// Default: create
		const result = createTicketSchema.safeParse(data);
		if (!result.success) throw error(400, result.error.issues[0].message);
		const ticket = createTicket(result.data, locals.user.id);
		return json(ticket, { status: 201 });
	} catch (e) {
		return translateServiceError(e);
	}
};
