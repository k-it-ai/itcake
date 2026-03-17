import type { Actions, PageServerLoad } from './$types.js';
import { redirect, fail } from '@sveltejs/kit';
import { clientSchema } from '$lib/validators.js';
import { createClient, peekNextClientNumber } from '$services/clients.js';
import { getSettingsSection } from '$services/settings.js';

export const load: PageServerLoad = async ({ locals }) => {
	if (!locals.user) throw redirect(302, '/login');

	const general = getSettingsSection('general') as Record<string, unknown>;
	const invoices = getSettingsSection('invoices') as Record<string, unknown>;
	const nextClientNumber = peekNextClientNumber();

	return {
		nextClientNumber,
		defaults: {
			language: (general?.language as string) || 'en',
			currency: (general?.currency as string) || 'EUR',
			paymentTermDays: (invoices?.defaultPaymentTermDays as number) ?? 30
		}
	};
};

export const actions: Actions = {
	default: async ({ request, locals }) => {
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

		createClient(result.data, locals.user.id);
		throw redirect(302, '/clients');
	}
};
