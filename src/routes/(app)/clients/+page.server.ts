import type { PageServerLoad } from './$types.js';
import { redirect } from '@sveltejs/kit';
import { getClients } from '$services/clients.js';
import { getInvoices } from '$services/invoices.js';
import { getSetting } from '$lib/server/db.js';
import type { GeneralSettings } from '$lib/types.js';

export const load: PageServerLoad = async ({ locals }) => {
	if (!locals.user) throw redirect(302, '/login');

	const clients = getClients();
	const invoices = getInvoices().filter((inv) => inv.invoiceType !== 'creditNote');

	// Aggregate paid + outstanding per client in a single pass
	const revenueMap: Record<string, { paid: number; outstanding: number }> = {};
	for (const inv of invoices) {
		if (!inv.clientId) continue;
		if (!revenueMap[inv.clientId]) revenueMap[inv.clientId] = { paid: 0, outstanding: 0 };
		if (inv.status === 'paid') {
			revenueMap[inv.clientId].paid += inv.totals.total;
		} else if (inv.status === 'sent' || inv.status === 'overdue') {
			revenueMap[inv.clientId].outstanding += inv.totals.total;
		}
	}

	const generalSettings = getSetting<GeneralSettings>('general');
	const currency = generalSettings.currency || 'EUR';

	return { clients, revenueMap, currency };
};
