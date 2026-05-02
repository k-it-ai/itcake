import type { Actions, PageServerLoad } from './$types.js';
import { redirect, fail, isRedirect } from '@sveltejs/kit';
import { getProposal, updateProposal, updateProposalStatus, removeProposal, duplicateProposal, convertToInvoice, PROPOSAL_STATUSES } from '$services/proposals.js';
import { getClientIdNames } from '$services/clients.js';
import { getCatalogItems } from '$services/catalog-items.js';
import { getSetting } from '$lib/server/db.js';
import { notFound, pickPresentKeys } from '$lib/server/request-utils.js';
import type { EmailSettings, AdvancedSettings, ProposalSettings, GeneralSettings } from '$lib/types.js';
import { updateProposalSchema } from '$lib/validators.js';
import { serverT } from '$lib/i18n/server.js';

export const load: PageServerLoad = async ({ params, locals }) => {
	if (!locals.user) throw redirect(302, '/login');
	const proposal = getProposal(params.id);
	if (!proposal) throw notFound();

	const emailSettings = getSetting<EmailSettings>('emails');
	const advanced = getSetting<AdvancedSettings>('advanced');
	const proposalSettings = getSetting<ProposalSettings>('proposals');

	return {
		proposal,
		clients: getClientIdNames(),
		catalogItems: getCatalogItems(),
		emailTemplate: emailSettings.proposalEmail,
		fromEmail: emailSettings.smtp?.fromName
			? `${emailSettings.smtp.fromName} <${emailSettings.smtp.from}>`
			: emailSettings.smtp?.from || '',
		kleinunternehmer: advanced?.kleinunternehmer === true,
		defaultTaxRate: proposalSettings.defaultTaxRate ?? 21
	};
};

export const actions: Actions = {
	update: async ({ request, params, locals }) => {
		const lang = getSetting<GeneralSettings>('general').language || 'de';
		const st = serverT(lang);
		if (!locals.user) return fail(401, { error: st('error.notAuthenticated') });

		const formData = await request.formData();
		const rawData = formData.get('data') as string;
		if (!rawData) return fail(400, { error: st('error.missingData') });

		let data: Record<string, unknown>;
		try { data = JSON.parse(rawData); } catch { return fail(400, { error: st('error.invalidJson') }); }

		const validated = updateProposalSchema.safeParse(data);
		if (!validated.success) return fail(400, { error: validated.error.issues[0].message });

		const safeData = pickPresentKeys(validated.data, data);
		// Status changes must go through the dedicated ?/status action.
		delete (safeData as Record<string, unknown>).status;
		try {
			const updated = updateProposal(params.id, safeData, locals.user.id);
			if (!updated) return fail(404, { error: st('error.proposalNotFound') });
			return { success: true };
		} catch (e) {
			if (e instanceof Error && e.message.includes('Cannot edit')) return fail(403, { error: e.message });
			if (e instanceof Error && e.message.includes('Cannot transition')) return fail(400, { error: e.message });
			return fail(500, { error: st('error.internalError') });
		}
	},

	status: async ({ request, params, locals }) => {
		const lang = getSetting<GeneralSettings>('general').language || 'de';
		const st = serverT(lang);
		if (!locals.user) return fail(401, { error: st('error.notAuthenticated') });

		const formData = await request.formData();
		const status = formData.get('status') as string;
		if (!status) return fail(400, { error: st('error.missingStatus') });

		if (!PROPOSAL_STATUSES.includes(status as typeof PROPOSAL_STATUSES[number])) return fail(400, { error: st('error.invalidStatus') });

		try {
			const updated = updateProposalStatus(params.id, status as 'draft' | 'sent' | 'accepted' | 'rejected' | 'expired', locals.user.id);
			if (!updated) return fail(404, { error: st('error.proposalNotFound') });
			return { success: true };
		} catch (e) {
			if (e instanceof Error && e.message.includes('Cannot transition')) return fail(400, { error: e.message });
			return fail(500, { error: st('error.internalError') });
		}
	},

	delete: async ({ params, locals }) => {
		const lang = getSetting<GeneralSettings>('general').language || 'de';
		const st = serverT(lang);
		if (!locals.user) return fail(401, { error: st('error.notAuthenticated') });
		try {
			const removed = removeProposal(params.id, locals.user.id);
			if (!removed) return fail(404, { error: st('error.proposalNotFound') });
			throw redirect(302, '/proposals');
		} catch (e) {
			if (isRedirect(e)) throw e;
			if (e instanceof Error && e.message.includes('Cannot delete')) return fail(403, { error: e.message });
			return fail(500, { error: st('error.internalError') });
		}
	},

	duplicate: async ({ params, locals }) => {
		const lang = getSetting<GeneralSettings>('general').language || 'de';
		const st = serverT(lang);
		if (!locals.user) return fail(401, { error: st('error.notAuthenticated') });
		try {
			const dup = duplicateProposal(params.id, locals.user.id);
			if (!dup) return fail(404, { error: st('error.proposalNotFound') });
			throw redirect(302, `/proposals/${dup.id}`);
		} catch (e) {
			if (isRedirect(e)) throw e;
			return fail(500, { error: st('error.internalError') });
		}
	},

	convertToInvoice: async ({ params, locals }) => {
		const lang = getSetting<GeneralSettings>('general').language || 'de';
		const st = serverT(lang);
		if (!locals.user) return fail(401, { error: st('error.notAuthenticated') });
		try {
			const invoice = convertToInvoice(params.id, locals.user.id);
			throw redirect(302, `/invoices/${invoice.id}`);
		} catch (e) {
			if (isRedirect(e)) throw e;
			const msg = e instanceof Error ? e.message : '';
			if (/not found|Cannot convert|Cannot transition/i.test(msg)) {
				return fail(msg.includes('not found') ? 404 : 400, { error: msg });
			}
			console.error('Convert to invoice failed:', msg);
			return fail(500, { error: st('error.internalError') });
		}
	}
};
