import type { Actions, PageServerLoad } from './$types.js';
import { redirect, fail, isRedirect } from '@sveltejs/kit';
import { getClientDropdownData } from '#services/clients.js';
import { createProposal } from '#services/proposals.js';
import { getCatalogItems } from '#services/catalog-items.js';
import { getSetting } from '#lib/server/db.js';
import type { ProposalSettings, GeneralSettings, AdvancedSettings } from '#lib/types.js';
import { createProposalSchema } from '#lib/validators.js';
import { serverT } from '#lib/i18n/server.js';

export const load: PageServerLoad = async ({ locals }) => {
	if (!locals.user) throw redirect(302, '/login');
	const advanced = getSetting<AdvancedSettings>('advanced');
	const generalSettings = getSetting<GeneralSettings>('general');
	return {
		clients: getClientDropdownData(),
		catalogItems: getCatalogItems(),
		defaults: getSetting<ProposalSettings>('proposals'),
		defaultCurrency: generalSettings.currency || 'EUR',
		defaultLanguage: generalSettings.language || 'en',
		kleinunternehmer: advanced?.kleinunternehmer === true
	};
};

export const actions: Actions = {
	default: async ({ request, locals }) => {
		const lang = getSetting<GeneralSettings>('general').language || 'de';
		const st = serverT(lang);
		if (!locals.user) return fail(401, { error: st('error.notAuthenticated') });

		const formData = await request.formData();
		const rawData = formData.get('data') as string;
		if (!rawData) return fail(400, { error: st('error.missingData') });

		let data: Record<string, unknown>;
		try { data = JSON.parse(rawData); } catch { return fail(400, { error: st('error.invalidJson') }); }

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
