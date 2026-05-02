import type { Actions, PageServerLoad } from './$types.js';
import { redirect, fail } from '@sveltejs/kit';
import { clientSchema } from '$lib/validators.js';
import { getClient, updateClient, removeClient } from '$services/clients.js';
import { getInvoicesByClient } from '$services/invoices.js';
import { getProposalsByClient } from '$services/proposals.js';
import { getTicketsByClient } from '$services/tickets.js';
import { getSetting } from '$lib/server/db.js';
import type { GeneralSettings } from '$lib/types.js';
import { serverT } from '$lib/i18n/server.js';
import { notFound } from '$lib/server/request-utils.js';

export const load: PageServerLoad = async ({ params, locals }) => {
	if (!locals.user) throw redirect(302, '/login');
	const client = getClient(params.id);
	if (!client) throw notFound();

	return {
		client,
		invoices: getInvoicesByClient(params.id),
		proposals: getProposalsByClient(params.id),
		tickets: getTicketsByClient(params.id)
	};
};

export const actions: Actions = {
	update: async ({ request, params, locals }) => {
		const lang = getSetting<GeneralSettings>('general').language || 'de';
		const st = serverT(lang);
		if (!locals.user) return fail(401, { error: st('error.notAuthenticated') });

		const formData = await request.formData();
		const data = Object.fromEntries(formData);

		const input = {
			clientNumber: (data.clientNumber as string) || '',
			name: data.name as string,
			email: (data.email as string) || '',
			phone: (data.phone as string) || '',
			website: (data.website as string) || '',
			vatNumber: (data.vatNumber as string) || '',
			registrationNumber: (data.registrationNumber as string) || '',
			address: {
				street: (data.street as string) || '',
				city: (data.city as string) || '',
				zip: (data.zip as string) || '',
				state: (data.state as string) || '',
				country: (data.country as string) || ''
			},
			notes: (data.notes as string) || '',
			contactPerson: (data.contactPerson as string) || '',
			language: (data.language as string) || 'en',
			currency: (data.currency as string) || 'EUR',
			paymentTermDays: parseInt((data.paymentTermDays as string) || '30', 10)
		};

		const result = clientSchema.safeParse(input);
		if (!result.success) {
			return fail(400, { error: result.error.issues[0].message });
		}

		updateClient(params.id, result.data, locals.user.id);
		throw redirect(302, '/clients');
	},

	delete: async ({ params, locals }) => {
		const lang = getSetting<GeneralSettings>('general').language || 'de';
		const st = serverT(lang);
		if (!locals.user) return fail(401, { error: st('error.notAuthenticated') });
		const result = removeClient(params.id, locals.user.id);
		if (!result.ok) return fail(400, { error: result.error ?? st('error.deleteError') });
		throw redirect(302, '/clients');
	}
};
