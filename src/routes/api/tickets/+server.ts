import { json, error } from '@sveltejs/kit';
import type { RequestHandler } from './$types.js';
import { handleActionPost, notFound, parseUpdateBody, requireId, requireUser } from '$lib/server/request-utils.js';
import { ticketSchema, updateTicketSchema } from '$lib/validators.js';
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
const SETTABLE_STATUSES: TicketStatus[] = ['open', 'completed'];
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export const GET: RequestHandler = async ({ url, locals }) => {
	requireUser(locals);

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

export const POST: RequestHandler = ({ request, locals }) =>
	handleActionPost(request, locals, {
		create: (data, userId) => {
			const result = ticketSchema.safeParse(data);
			if (!result.success) throw error(400, result.error.issues[0].message);
			return json(createTicket(result.data, userId), { status: 201 });
		},
		actions: {
			update: (data, userId) => {
				const id = requireId(data);
				const { id: _, ...rest } = data;
				const safe = parseUpdateBody(updateTicketSchema, rest);
				const updated = updateTicket(id, safe, userId);
				if (!updated) throw notFound();
				return json(updated);
			},
			delete: (data, userId) => {
				const id = requireId(data);
				if (!removeTicket(id, userId)) throw notFound();
				return json({ ok: true });
			},
			status: (data, userId) => {
				const id = requireId(data);
				const status = data.status;
				if (!SETTABLE_STATUSES.includes(status as TicketStatus)) throw error(400, 'Invalid status');
				const updated = updateTicketStatus(id, status as TicketStatus, userId);
				if (!updated) throw notFound();
				return json(updated);
			},
			toInvoice: (data, userId) => {
				const id = requireId(data);
				const mode = data.mode;
				if (mode !== 'new' && mode !== 'existing') throw error(400, 'Invalid mode');
				const invoiceId = data.invoiceId;
				return json(convertTicketToInvoice(id, { mode, invoiceId: invoiceId as string | undefined }, userId), { status: 201 });
			}
		}
	});
