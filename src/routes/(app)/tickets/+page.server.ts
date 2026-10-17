import { redirect } from '@sveltejs/kit';
import type { PageServerLoad } from './$types.js';
import { getTicketsPaginated, getTicketsByDateRange, getTicketStats } from '#services/tickets.js';
import { getClientIdNames } from '#services/clients.js';
import { getSetting } from '#lib/server/db.js';
import { getInvoicesByStatus } from '#services/invoices.js';
import type { AdvancedSettings, GeneralSettings } from '#lib/types.js';
import dayjs from 'dayjs';

export const load: PageServerLoad = async ({ locals, url }) => {
	if (!locals.user) throw redirect(302, '/login');

	const clients = getClientIdNames();
	const advanced = getSetting<AdvancedSettings>('advanced');
	const general = getSetting<GeneralSettings>('general');
	const editLock = advanced?.editLock ?? 'none';

	const draftInvoices = getInvoicesByStatus('draft');
	const sentInvoices = editLock !== 'sent' ? getInvoicesByStatus('sent') : [];
	const targetInvoices = [...draftInvoices, ...sentInvoices];

	const page = Math.max(1, parseInt(url.searchParams.get('page') ?? '1', 10) || 1);
	const status = url.searchParams.get('status') || '';
	const clientId = url.searchParams.get('clientId') || '';
	const search = url.searchParams.get('q') || '';
	const dateFrom = url.searchParams.get('from') || '';
	const dateTo = url.searchParams.get('to') || '';

	const result = getTicketsPaginated(
		{ status: status || undefined, clientId: clientId || undefined, search: search || undefined, dateFrom: dateFrom || undefined, dateTo: dateTo || undefined },
		page
	);

	const calendarFrom = url.searchParams.get('calFrom') || '';
	const calendarTo = url.searchParams.get('calTo') || '';
	const calendarTickets = (calendarFrom && calendarTo) ? getTicketsByDateRange(calendarFrom, calendarTo) : [];

	const now = dayjs();
	const weekStart = now.startOf('week').add(now.day() === 0 ? -6 : 1, 'day').format('YYYY-MM-DD');
	const monthStart = now.startOf('month').format('YYYY-MM-DD');
	const today = now.format('YYYY-MM-DD');
	const stats = getTicketStats(weekStart, monthStart, today);

	return {
		tickets: result.items,
		total: result.total,
		page: result.page,
		pageSize: result.pageSize,
		calendarTickets,
		clients,
		targetInvoices,
		stats,
		settings: { general },
		filters: { status, clientId, search, dateFrom, dateTo }
	};
};
