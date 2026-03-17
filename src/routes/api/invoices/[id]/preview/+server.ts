import { error } from '@sveltejs/kit';
import type { RequestHandler } from './$types.js';
import { getInvoice } from '$services/invoices.js';
import { renderDocument } from '$lib/server/template-renderer.js';

export const GET: RequestHandler = async ({ params, locals }) => {
	if (!locals.user) throw error(401);

	const invoice = getInvoice(params.id);
	if (!invoice) throw error(404, 'Invoice not found');

	let html: string;
	try {
		html = renderDocument(invoice, 'invoice');
	} catch (e) {
		console.error(`Preview render failed for invoice ${params.id}:`, e);
		throw error(500, 'Preview render failed');
	}

	return new Response(html, {
		headers: {
			'Content-Type': 'text/html; charset=utf-8',
			'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; img-src data:; font-src data:"
		}
	});
};
