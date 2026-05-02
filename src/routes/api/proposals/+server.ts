import { json, error } from '@sveltejs/kit';
import type { RequestHandler } from './$types.js';
import { handleActionPost, notFound, parseUpdateBody, requireId, requireUser } from '$lib/server/request-utils.js';
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
	requireUser(locals);

	const status = url.searchParams.get('status');
	if (status && !PROPOSAL_STATUSES.includes(status as typeof PROPOSAL_STATUSES[number])) throw error(400, 'Invalid status');
	const proposals = status ? getProposalsByStatus(status as typeof PROPOSAL_STATUSES[number]) : getProposals();
	return json(proposals);
};

export const POST: RequestHandler = ({ request, locals }) =>
	handleActionPost(request, locals, {
		create: (data, userId) => {
			const result = createProposalSchema.safeParse(data);
			if (!result.success) throw error(400, result.error.issues[0].message);
			return json(createProposal(result.data, userId), { status: 201 });
		},
		actions: {
			update: (data, userId) => {
				const id = requireId(data);
				const { id: _, ...rest } = data;
				const safe = parseUpdateBody(updateProposalSchema, rest);
				const updated = updateProposal(id, safe, userId);
				if (!updated) throw notFound();
				return json(updated);
			},
			delete: (data, userId) => {
				const id = requireId(data);
				if (!removeProposal(id, userId)) throw notFound();
				return json({ ok: true });
			}
		}
	});
