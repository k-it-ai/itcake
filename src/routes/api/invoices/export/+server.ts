import { error } from '@sveltejs/kit';
import type { RequestHandler } from './$types.js';
import { parseJsonBody, requireUser } from '$lib/server/request-utils.js';
import { getInvoices, getInvoice, getInvoiceCount } from '$services/invoices.js';
import { renderDocument } from '$lib/server/template-renderer.js';
import { generatePdf } from '$lib/server/pdf.js';
import { safeFilename } from '$lib/server/sanitize.js';
import JSZip from 'jszip';

const MAX_EXPORT = 100;

export const POST: RequestHandler = async ({ request, locals }) => {
	requireUser(locals);

	const body = await parseJsonBody<Record<string, unknown>>(request);
	const ids = body.ids;

	if (ids !== undefined && (!Array.isArray(ids) || ids.some((id) => typeof id !== 'string'))) {
		throw error(400, 'ids must be an array of strings');
	}
	if (ids && ids.length === 0) {
		throw error(400, 'No invoice IDs provided');
	}
	if (ids && ids.length > MAX_EXPORT) {
		throw error(400, `Export limited to ${MAX_EXPORT} invoices per request`);
	}

	let invoices;
	if (ids && ids.length > 0) {
		const uniqueIds = [...new Set(ids as string[])];
		invoices = uniqueIds.map((id: string) => getInvoice(id)).filter(Boolean) as ReturnType<typeof getInvoices>;
	} else {
		// Check count via SQL before loading all rows to prevent OOM on large datasets
		const count = getInvoiceCount();
		if (count > MAX_EXPORT) {
			throw error(400, `Export limited to ${MAX_EXPORT} invoices per request. Found ${count}. Please select specific invoices.`);
		}
		invoices = getInvoices();
	}

	if (invoices.length === 0) throw error(400, 'No invoices to export');

	// Single invoice — return PDF directly
	if (invoices.length === 1) {
		const inv = invoices[0];
		try {
			const html = renderDocument(inv, 'invoice');
			const pdf = await generatePdf(html);
			const prefix = inv.invoiceType === 'creditNote' ? 'CreditNote' : 'Invoice';
			return new Response(new Uint8Array(pdf), {
				headers: {
					'Content-Type': 'application/pdf',
					'Content-Disposition': `attachment; filename="${prefix}-${safeFilename(inv.documentId)}.pdf"`
				}
			});
		} catch (e) {
			console.error(`PDF generation failed for ${inv.documentId}:`, e);
			throw error(500, 'PDF generation failed');
		}
	}

	// Multiple invoices — generate PDFs concurrently (Semaphore(4) in pdf.ts limits parallelism)
	// Use allSettled so one broken invoice doesn't fail the entire export
	const zip = new JSZip();
	const pdfResults = await Promise.allSettled(
		invoices.map(async (inv) => {
			const html = renderDocument(inv, 'invoice');
			const pdf = await generatePdf(html);
			const prefix = inv.invoiceType === 'creditNote' ? 'CreditNote' : 'Invoice';
			return { name: `${prefix}-${safeFilename(inv.documentId)}.pdf`, buffer: pdf };
		})
	);
	let added = 0;
	const failures: string[] = [];
	for (let i = 0; i < pdfResults.length; i++) {
		const result = pdfResults[i];
		if (result.status === 'fulfilled') {
			zip.file(result.value.name, result.value.buffer);
			added++;
		} else {
			const inv = invoices[i];
			failures.push(`${inv.documentId}: PDF generation failed`);
			console.error(`Failed to generate PDF for ${inv.documentId}:`, result.reason);
		}
	}
	if (added === 0) throw error(500, 'Failed to generate any PDFs for export');

	if (failures.length > 0) {
		zip.file('_export-errors.txt', `The following invoices could not be exported:\n\n${failures.join('\n')}\n`);
	}

	const zipBuffer = await zip.generateAsync({ type: 'nodebuffer' });
	return new Response(new Uint8Array(zipBuffer), {
		headers: {
			'Content-Type': 'application/zip',
			'Content-Disposition': `attachment; filename="invoices-export.zip"`,
			...(failures.length > 0 ? { 'X-Export-Failed': String(failures.length) } : {})
		}
	});
};
