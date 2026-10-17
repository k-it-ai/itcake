import { error, isHttpError } from '@sveltejs/kit';
import type { RequestHandler } from './$types.js';
import { getProposal } from '#services/proposals.js';
import { renderDocument } from '#lib/server/template-renderer.js';
import { generatePdf } from '#lib/server/pdf.js';
import { safeFilename } from '#lib/server/sanitize.js';
import { notFound, requireUser, translateServiceError } from '#lib/server/request-utils.js';
import { ServiceError } from '#lib/server/service-error.js';

export const GET: RequestHandler = async ({ params, locals }) => {
	requireUser(locals);

	const proposal = getProposal(params.id);
	if (!proposal) throw notFound();

	let html: string;
	let pdfBuffer: Buffer;
	try {
		html = renderDocument(proposal, 'proposal');
		pdfBuffer = await generatePdf(html);
	} catch (e) {
		if (e instanceof ServiceError) translateServiceError(e);
		if (isHttpError(e)) throw e;
		console.error(`PDF generation failed for proposal ${params.id}:`, e);
		throw error(500, 'PDF generation failed');
	}

	const safeId = safeFilename(proposal.documentId);
	const filename = `${safeId}.pdf`;
	const originalFilename = `${proposal.documentId}.pdf`;

	return new Response(new Uint8Array(pdfBuffer), {
		headers: {
			'Content-Type': 'application/pdf',
			'Content-Disposition': `attachment; filename="${filename}"; filename*=UTF-8''${encodeURIComponent(originalFilename)}`
		}
	});
};
