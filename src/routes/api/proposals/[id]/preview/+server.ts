import { error } from '@sveltejs/kit';
import type { RequestHandler } from './$types.js';
import { getProposal } from '$services/proposals.js';
import { renderDocument } from '$lib/server/template-renderer.js';

export const GET: RequestHandler = async ({ params, locals }) => {
	if (!locals.user) throw error(401);

	const proposal = getProposal(params.id);
	if (!proposal) throw error(404, 'Proposal not found');

	let html: string;
	try {
		html = renderDocument(proposal, 'proposal');
	} catch (e) {
		console.error(`Preview render failed for proposal ${params.id}:`, e);
		throw error(500, 'Preview render failed');
	}

	return new Response(html, {
		headers: {
			'Content-Type': 'text/html; charset=utf-8',
			'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; img-src data:; font-src data:"
		}
	});
};
