import { error } from '@sveltejs/kit';
import type { RequestHandler } from './$types.js';
import { getInvoice } from '$services/invoices.js';
import { renderDocument } from '$lib/server/template-renderer.js';
import { generatePdf } from '$lib/server/pdf.js';
import { safeFilename } from '$lib/server/sanitize.js';

export const GET: RequestHandler = async ({ params, locals }) => {
	if (!locals.user) throw error(401);

	const invoice = getInvoice(params.id);
	if (!invoice) throw error(404, 'Invoice not found');

	let html: string;
	let pdfBuffer: Buffer;
	try {
		html = renderDocument(invoice, 'invoice');
		pdfBuffer = await generatePdf(html);
	} catch (e) {
		console.error(`PDF generation failed for invoice ${params.id}:`, e);
		throw error(500, 'PDF generation failed');
	}

	const safeId = safeFilename(invoice.documentId);
	const filename = `${safeId}.pdf`;
	const originalFilename = `${invoice.documentId}.pdf`;

	return new Response(new Uint8Array(pdfBuffer), {
		headers: {
			'Content-Type': 'application/pdf',
			'Content-Disposition': `attachment; filename="${filename}"; filename*=UTF-8''${encodeURIComponent(originalFilename)}`
		}
	});
};
