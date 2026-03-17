import type { Actions, PageServerLoad } from './$types.js';
import { redirect, fail, error } from '@sveltejs/kit';
import { clientSchema } from '$lib/validators.js';
import { getClient, updateClient, removeClient } from '$services/clients.js';
import { getInvoicesByClient } from '$services/invoices.js';
import { getProposalsByClient } from '$services/proposals.js';

export const load: PageServerLoad = async ({ params, locals }) => {
	if (!locals.user) throw redirect(302, '/login');
	const client = getClient(params.id);
	if (!client) throw error(404, 'Client not found');

	return {
		client,
		invoices: getInvoicesByClient(params.id),
		proposals: getProposalsByClient(params.id)
	};
};

export const actions: Actions = {
	update: async ({ request, params, locals }) => {
		if (!locals.user) return fail(401, { error: 'Not authenticated' });

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
		if (!locals.user) return fail(401, { error: 'Not authenticated' });
		const result = removeClient(params.id, locals.user.id);
		if (!result.ok) return fail(400, { error: result.error ?? 'Delete failed' });
		throw redirect(302, '/clients');
	}
};
