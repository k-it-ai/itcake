import { json, error } from '@sveltejs/kit';
import type { RequestHandler } from './$types.js';
import { parseJsonBody, translateServiceError, pickPresentKeys } from '$lib/server/request-utils.js';
import { createProposalSchema, updateProposalSchema } from '$lib/validators.js';
import {
	getProposals,
	getProposalsByStatus,
	createProposal,
	updateProposal,
	removeProposal,
	PROPOSAL_STATUSES
} from '$services/proposals.js';

export const GET: RequestHandler = async ({ locals, url }) => {
	if (!locals.user) throw error(401);

	const status = url.searchParams.get('status');
	if (status && !PROPOSAL_STATUSES.includes(status as typeof PROPOSAL_STATUSES[number])) throw error(400, 'Invalid status');
	const proposals = status ? getProposalsByStatus(status as typeof PROPOSAL_STATUSES[number]) : getProposals();
	return json(proposals);
};

export const POST: RequestHandler = async ({ request, locals }) => {
	if (!locals.user) throw error(401);

	const body = await parseJsonBody(request);
	const { action, ...data } = body as { action?: string; [key: string]: unknown };

	if (action && action !== 'update' && action !== 'delete') {
		throw error(400, 'Invalid action');
	}

	if (action === 'update') {
		const { id, ...updateData } = data as { id: string; [key: string]: unknown };
		if (typeof id !== 'string' || !id) throw error(400, 'Missing or invalid id');
		const validated = updateProposalSchema.safeParse(updateData);
		if (!validated.success) throw error(400, validated.error.issues[0].message);
		const safeData = pickPresentKeys(validated.data, updateData);
		// Status changes must go through the dedicated 'status' action.
		delete (safeData as Record<string, unknown>).status;
		try {
			const updated = updateProposal(id, safeData, locals.user.id);
			if (!updated) throw error(404, 'Proposal not found');
			return json(updated);
		} catch (e) { return translateServiceError(e); }
	}

	if (action === 'delete') {
		const { id } = data as { id: string };
		if (typeof id !== 'string' || !id) throw error(400, 'Missing or invalid id');
		try {
			const removed = removeProposal(id, locals.user.id);
			if (!removed) throw error(404, 'Proposal not found');
			return json({ ok: true });
		} catch (e) { return translateServiceError(e); }
	}

	const result = createProposalSchema.safeParse(data);
	if (!result.success) throw error(400, result.error.issues[0].message);
	try {
		const proposal = createProposal(result.data, locals.user.id);
		return json(proposal, { status: 201 });
	} catch (e) { return translateServiceError(e); }
};
