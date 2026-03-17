import type { Actions, PageServerLoad } from './$types.js';
import { redirect, fail, isRedirect } from '@sveltejs/kit';
import { getClients } from '$services/clients.js';
import { createProposal } from '$services/proposals.js';
import { getTemplates } from '$services/templates.js';
import { getCatalogItems } from '$services/catalog-items.js';
import { getSetting } from '$lib/server/db.js';
import type { ProposalSettings, GeneralSettings, AdvancedSettings } from '$lib/types.js';
import { createProposalSchema } from '$lib/validators.js';

export const load: PageServerLoad = async ({ locals }) => {
	if (!locals.user) throw redirect(302, '/login');
	const advanced = getSetting<AdvancedSettings>('advanced');
	const generalSettings = getSetting<GeneralSettings>('general');
	return {
		clients: getClients(),
		templates: getTemplates(),
		catalogItems: getCatalogItems(),
		defaults: getSetting<ProposalSettings>('proposals'),
		defaultCurrency: generalSettings.currency || 'EUR',
		defaultLanguage: generalSettings.language || 'en',
		kleinunternehmer: advanced?.kleinunternehmer === true
	};
};

export const actions: Actions = {
	default: async ({ request, locals }) => {
		if (!locals.user) return fail(401, { error: 'Not authenticated' });

		const formData = await request.formData();
		const rawData = formData.get('data') as string;
		if (!rawData) return fail(400, { error: 'Missing data' });

		let data: Record<string, unknown>;
		try { data = JSON.parse(rawData); } catch { return fail(400, { error: 'Invalid JSON' }); }

		const validated = createProposalSchema.safeParse(data);
		if (!validated.success) {
			return fail(400, { error: validated.error.issues[0].message });
		}

		try {
			const proposal = createProposal(validated.data, locals.user.id);
			throw redirect(302, `/proposals/${proposal.id}`);
		} catch (e) {
			if (isRedirect(e)) throw e;
			return fail(400, { error: (e as Error).message });
		}
	}
};
