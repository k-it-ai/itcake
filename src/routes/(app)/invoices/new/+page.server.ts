import type { Actions, PageServerLoad } from './$types.js';
import { redirect, fail, isRedirect } from '@sveltejs/kit';
import { getClients } from '$services/clients.js';
import { createInvoice } from '$services/invoices.js';
import { getTemplates } from '$services/templates.js';
import { getUnits } from '$services/units.js';
import { getCatalogItems } from '$services/catalog-items.js';
import { getSetting } from '$lib/server/db.js';
import type { InvoiceSettings, GeneralSettings, AdvancedSettings } from '$lib/types.js';
import { createInvoiceSchema } from '$lib/validators.js';

export const load: PageServerLoad = async ({ locals, url }) => {
	if (!locals.user) throw redirect(302, '/login');
	const invoiceSettings = getSetting<InvoiceSettings>('invoices');
	const generalSettings = getSetting<GeneralSettings>('general');
	const advanced = getSetting<AdvancedSettings>('advanced');
	const prefillClientId = url.searchParams.get('clientId') ?? '';
	return {
		clients: getClients(),
		templates: getTemplates(),
		units: getUnits(),
		catalogItems: getCatalogItems(),
		defaults: invoiceSettings,
		defaultCurrency: generalSettings.currency || 'EUR',
		defaultLanguage: generalSettings.language || 'en',
		prefillClientId,
		kleinunternehmer: advanced?.kleinunternehmer === true
	};
};

export const actions: Actions = {
	default: async ({ request, locals }) => {
		if (!locals.user) return fail(401, { error: 'Not authenticated' });

		const formData = await request.formData();
		const rawData = formData.get('data') as string;

		if (!rawData) return fail(400, { error: 'Missing invoice data' });

		let data: Record<string, unknown>;
		try {
			data = JSON.parse(rawData);
		} catch {
			return fail(400, { error: 'Invalid JSON data' });
		}

		const validated = createInvoiceSchema.safeParse(data);
		if (!validated.success) {
			return fail(400, { error: validated.error.issues[0].message });
		}

		try {
			const invoice = createInvoice(validated.data, locals.user.id);
			throw redirect(302, `/invoices/${invoice.id}`);
		} catch (e) {
			if (isRedirect(e)) throw e;
			return fail(400, { error: (e as Error).message });
		}
	}
};
