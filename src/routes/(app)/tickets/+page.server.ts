import { redirect } from '@sveltejs/kit';
import type { PageServerLoad } from './$types.js';
import { getTickets } from '$services/tickets.js';
import { getDocumentsByType, getSetting } from '$lib/server/db.js';
import { getInvoicesByStatus } from '$services/invoices.js';
import type { Client, AdvancedSettings } from '$lib/types.js';

export const load: PageServerLoad = async ({ locals }) => {
	if (!locals.user) throw redirect(302, '/login');

	const tickets = getTickets();
	const clients = getDocumentsByType<Client>('client');
	const advanced = getSetting<AdvancedSettings>('advanced');
	const editLock = advanced?.editLock ?? 'none';

	// Load invoices that tickets can be added to
	const draftInvoices = getInvoicesByStatus('draft');
	const sentInvoices = editLock !== 'sent' ? getInvoicesByStatus('sent') : [];
	const targetInvoices = [...draftInvoices, ...sentInvoices];

	return { tickets, clients, targetInvoices };
};
