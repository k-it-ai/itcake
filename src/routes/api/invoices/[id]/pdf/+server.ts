import { error, isHttpError } from '@sveltejs/kit';
import type { RequestHandler } from './$types.js';
import { getInvoice } from '#services/invoices.js';
import { renderDocument } from '#lib/server/template-renderer.js';
import { generatePdf } from '#lib/server/pdf.js';
import { safeFilename } from '#lib/server/sanitize.js';
import { notFound, requireUser, translateServiceError } from '#lib/server/request-utils.js';
import { ServiceError } from '#lib/server/service-error.js';

export const GET: RequestHandler = async ({ params, locals }) => {
	requireUser(locals);

	const invoice = getInvoice(params.id);
	if (!invoice) throw notFound();

	let html: string;
	let pdfBuffer: Buffer;
	try {
		html = renderDocument(invoice, 'invoice');
		pdfBuffer = await generatePdf(html);
	} catch (e) {
		if (e instanceof ServiceError) translateServiceError(e);
		if (isHttpError(e)) throw e;
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
