import type { Actions, PageServerLoad } from './$types.js';
import { redirect, fail, error, isRedirect } from '@sveltejs/kit';
import { getProposal, updateProposal, updateProposalStatus, removeProposal, duplicateProposal, convertToInvoice, PROPOSAL_STATUSES } from '$services/proposals.js';
import { getClients } from '$services/clients.js';
import { getTemplates } from '$services/templates.js';
import { getCatalogItems } from '$services/catalog-items.js';
import { getSetting } from '$lib/server/db.js';
import type { EmailSettings, AdvancedSettings, ProposalSettings } from '$lib/types.js';
import { updateProposalSchema } from '$lib/validators.js';

export const load: PageServerLoad = async ({ params, locals }) => {
	if (!locals.user) throw redirect(302, '/login');
	const proposal = getProposal(params.id);
	if (!proposal) throw error(404, 'Proposal not found');

	const emailSettings = getSetting<EmailSettings>('emails');
	const advanced = getSetting<AdvancedSettings>('advanced');
	const proposalSettings = getSetting<ProposalSettings>('proposals');

	return {
		proposal,
		clients: getClients(),
		templates: getTemplates(),
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
		if (!locals.user) return fail(401, { error: 'Not authenticated' });

		const formData = await request.formData();
		const rawData = formData.get('data') as string;
		if (!rawData) return fail(400, { error: 'Missing data' });

		let data: Record<string, unknown>;
		try { data = JSON.parse(rawData); } catch { return fail(400, { error: 'Invalid JSON' }); }

		const validated = updateProposalSchema.safeParse(data);
		if (!validated.success) return fail(400, { error: validated.error.issues[0].message });

		// Strip status — status changes must go through the dedicated ?/status action
		const { status: _ignoredStatus, ...safeData } = validated.data;
		try {
			const updated = updateProposal(params.id, safeData, locals.user.id);
			if (!updated) return fail(404, { error: 'Proposal not found' });
			return { success: true };
		} catch (e) {
			if (e instanceof Error && e.message.includes('Cannot edit')) return fail(403, { error: e.message });
			if (e instanceof Error && e.message.includes('Cannot transition')) return fail(400, { error: e.message });
			return fail(500, { error: 'Internal error' });
		}
	},

	status: async ({ request, params, locals }) => {
		if (!locals.user) return fail(401, { error: 'Not authenticated' });

		const formData = await request.formData();
		const status = formData.get('status') as string;
		if (!status) return fail(400, { error: 'Missing status' });

		if (!PROPOSAL_STATUSES.includes(status as typeof PROPOSAL_STATUSES[number])) return fail(400, { error: 'Invalid status' });

		try {
			const updated = updateProposalStatus(params.id, status as 'draft' | 'sent' | 'accepted' | 'rejected' | 'expired', locals.user.id);
			if (!updated) return fail(404, { error: 'Proposal not found' });
			return { success: true };
		} catch (e) {
			if (e instanceof Error && e.message.includes('Cannot transition')) return fail(400, { error: e.message });
			return fail(500, { error: 'Internal error' });
		}
	},

	delete: async ({ params, locals }) => {
		if (!locals.user) return fail(401, { error: 'Not authenticated' });
		try {
			const removed = removeProposal(params.id, locals.user.id);
			if (!removed) return fail(404, { error: 'Proposal not found' });
			throw redirect(302, '/proposals');
		} catch (e) {
			if (isRedirect(e)) throw e;
			if (e instanceof Error && e.message.includes('Cannot delete')) return fail(403, { error: e.message });
			return fail(500, { error: 'Internal error' });
		}
	},

	duplicate: async ({ params, locals }) => {
		if (!locals.user) return fail(401, { error: 'Not authenticated' });
		try {
			const dup = duplicateProposal(params.id, locals.user.id);
			if (!dup) return fail(404, { error: 'Proposal not found' });
			throw redirect(302, `/proposals/${dup.id}`);
		} catch (e) {
			if (isRedirect(e)) throw e;
			return fail(500, { error: 'Internal error' });
		}
	},

	convertToInvoice: async ({ params, locals }) => {
		if (!locals.user) return fail(401, { error: 'Not authenticated' });
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
			return fail(500, { error: 'Internal error' });
		}
	}
};
