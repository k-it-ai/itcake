import { json, error, isHttpError } from '@sveltejs/kit';
import type { RequestHandler } from './$types.js';
import { notFound, parseJsonBody, requireUser } from '$lib/server/request-utils.js';
import { sendEmailSchema } from '$lib/validators.js';
import { sendEmail, testSmtpConnection } from '$services/emails.js';
import { getInvoice, updateInvoice } from '$services/invoices.js';
import { getProposal, updateProposal } from '$services/proposals.js';
import { recordChange } from '$lib/server/changes.js';
import { renderDocument } from '$lib/server/template-renderer.js';
import { generatePdf } from '$lib/server/pdf.js';
import { getSetting } from '$lib/server/db.js';
import { safeFilename, sanitizeSmtpError } from '$lib/server/sanitize.js';
import { checkAndRecordEmailSend } from '$lib/server/rate-limit.js';
import type { EmailSettings } from '$lib/types.js';

export const POST: RequestHandler = async ({ request, locals }) => {
	requireUser(locals);

	const body = await parseJsonBody(request);
	const { action, ...data } = body as { action?: string; [key: string]: unknown };

	if (action === 'test') {
		// The settings page must save first, then test — this way arbitrary host/port
		const emailSettings = getSetting<EmailSettings>('emails');
		const s = emailSettings.smtp;
		if (!s?.host) {
			return json({ ok: false, error: 'No SMTP settings configured. Save settings first.' });
		}
		const settings = { host: s.host, port: s.port, secure: s.secure, user: s.user, pass: s.pass };

		const result = await testSmtpConnection(settings);
		return json({ ok: result.success, error: result.error ? sanitizeSmtpError(new Error(result.error)) : undefined });
	}

	const result = sendEmailSchema.safeParse(data);
	if (!result.success) throw error(400, result.error.issues[0].message);

	checkAndRecordEmailSend(locals.user.id);

	let attachmentBuffer: Buffer | undefined;
	let attachmentName: string | undefined;

	if (result.data.attachmentId && result.data.attachmentType) {
		const { attachmentId, attachmentType } = result.data;

		try {
			if (attachmentType === 'invoice') {
				const invoice = getInvoice(attachmentId);
				if (!invoice) throw notFound();
				const html = renderDocument(invoice, 'invoice');
				const prefix = invoice.invoiceType === 'creditNote' ? 'CreditNote' : 'Invoice';
				attachmentName = `${prefix}-${safeFilename(invoice.documentId)}.pdf`;
				attachmentBuffer = await generatePdf(html);
			} else {
				const proposal = getProposal(attachmentId);
				if (!proposal) throw notFound();
				const html = renderDocument(proposal, 'proposal');
				attachmentName = `Proposal-${safeFilename(proposal.documentId)}.pdf`;
				attachmentBuffer = await generatePdf(html);
			}
		} catch (e) {
			if (isHttpError(e)) throw e;
			console.error(`PDF generation failed for ${attachmentType} ${attachmentId}:`, e instanceof Error ? e.message : e);
			return json({ ok: false, error: 'Failed to generate PDF attachment' }, { status: 500 });
		}
	}

	try {
		await sendEmail({
			to: result.data.to,
			cc: result.data.cc,
			bcc: result.data.bcc,
			subject: result.data.subject,
			body: result.data.body,
			attachmentBuffer,
			attachmentName
		});
	} catch (err) {
		return json({ ok: false, error: sanitizeSmtpError(err) }, { status: 502 });
	}

	if (result.data.attachmentId) {
		const entityType = result.data.attachmentType === 'invoice' ? 'invoice' : 'proposal';
		recordChange(entityType, result.data.attachmentId, 'send_email', { to: { old: null, new: result.data.to } }, locals.user.id);

		try {
			if (result.data.attachmentType === 'invoice') {
				updateInvoice(result.data.attachmentId, { sentTo: result.data.to }, locals.user.id);
			} else if (result.data.attachmentType === 'proposal') {
				updateProposal(result.data.attachmentId, { sentTo: result.data.to }, locals.user.id);
			}
		} catch (e) {
			console.warn(`Failed to update sentTo on ${result.data.attachmentType} ${result.data.attachmentId}:`, e instanceof Error ? e.message : e);
		}
	}

	return json({ ok: true });
};
