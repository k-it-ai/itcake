import { error } from '@sveltejs/kit';
import type { RequestHandler } from './$types.js';
import { getProposal } from '$services/proposals.js';
import { renderDocument } from '$lib/server/template-renderer.js';
import { notFound, requireUser } from '$lib/server/request-utils.js';

export const GET: RequestHandler = async ({ params, locals }) => {
	requireUser(locals);

	const proposal = getProposal(params.id);
	if (!proposal) throw notFound();

	let html: string;
	try {
		html = renderDocument(proposal, 'proposal');
	} catch (e) {
		console.error(`Preview render failed for proposal ${params.id}:`, e);
		throw error(500, 'Preview render failed');
	}

	return new Response(html, {
		headers: {
			'Content-Type': 'text/html; charset=utf-8'
		}
	});
};
