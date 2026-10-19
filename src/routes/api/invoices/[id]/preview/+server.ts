import { error } from '@sveltejs/kit';
import type { RequestHandler } from './$types.js';
import { getInvoice } from '#services/invoices.js';
import { renderDocument } from '#lib/server/template-renderer.js';
import { notFound, requireUser } from '#lib/server/request-utils.js';

export const GET: RequestHandler = async ({ params, locals }) => {
	requireUser(locals);

	const invoice = getInvoice(params.id);
	if (!invoice) throw notFound();

	let html: string;
	try {
		html = renderDocument(invoice, 'invoice');
	} catch (e) {
		console.error(`Preview render failed for invoice ${params.id}:`, e);
		throw error(500, 'Preview render failed');
	}

	return new Response(html, {
		headers: {
			'Content-Type': 'text/html; charset=utf-8'
		}
	});
};
