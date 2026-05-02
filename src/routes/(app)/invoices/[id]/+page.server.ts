import type { Actions, PageServerLoad } from './$types.js';
import { redirect, fail, isRedirect, isHttpError } from '@sveltejs/kit';
import { getInvoice, updateInvoice, updateInvoiceStatus, removeInvoice, duplicateInvoice, createCreditNote, isEditLocked, INVOICE_STATUSES } from '$services/invoices.js';
import { getClientIdNames } from '$services/clients.js';
import { getCatalogItems } from '$services/catalog-items.js';
import { sendEmail } from '$services/emails.js';
import { renderDocument } from '$lib/server/template-renderer.js';
import { generatePdf } from '$lib/server/pdf.js';
import { getSetting } from '$lib/server/db.js';
import { safeFilename, sanitizeSmtpError } from '$lib/server/sanitize.js';
import { notFound, pickPresentKeys, failFromServiceError } from '$lib/server/request-utils.js';
import { checkAndRecordEmailSend } from '$lib/server/rate-limit.js';
import type { EmailSettings, AdvancedSettings, InvoiceSettings, GeneralSettings } from '$lib/types.js';
import { updateInvoiceSchema } from '$lib/validators.js';
import { formatMoney } from '$lib/money.js';
import { serverT } from '$lib/i18n/server.js';

export const load: PageServerLoad = async ({ params, locals }) => {
	if (!locals.user) throw redirect(302, '/login');
	const invoice = getInvoice(params.id);
	if (!invoice) throw notFound();

	const emailSettings = getSetting<EmailSettings>('emails');
	const advanced = getSetting<AdvancedSettings>('advanced');
	const invoiceSettings = getSetting<InvoiceSettings>('invoices');

	return {
		invoice,
		editLocked: isEditLocked(invoice),
		clients: getClientIdNames(),
		catalogItems: getCatalogItems(),
		emailTemplate: invoice.invoiceType === 'creditNote'
			? emailSettings.creditNoteEmail
			: emailSettings.invoiceEmail,
		reminderTemplate: emailSettings.reminderEmail,
		fromEmail: emailSettings.smtp?.fromName
			? `${emailSettings.smtp.fromName} <${emailSettings.smtp.from}>`
			: emailSettings.smtp?.from || '',
		kleinunternehmer: advanced?.kleinunternehmer === true,
		defaultTaxRate: invoiceSettings.defaultTaxRate ?? 21
	};
};

export const actions: Actions = {
	update: async ({ request, params, locals }) => {
		const lang = getSetting<GeneralSettings>('general').language || 'de';
		const st = serverT(lang);
		if (!locals.user) return fail(401, { error: st('error.notAuthenticated') });

		const formData = await request.formData();
		const rawData = formData.get('data') as string;
		if (!rawData) return fail(400, { error: st('error.missingData') });

		let data: Record<string, unknown>;
		try { data = JSON.parse(rawData); } catch { return fail(400, { error: st('error.invalidJson') }); }

		const validated = updateInvoiceSchema.safeParse(data);
		if (!validated.success) return fail(400, { error: validated.error.issues[0].message });

		const safeData = pickPresentKeys(validated.data, data);
		// Status changes must go through the dedicated ?/status action.
		delete (safeData as Record<string, unknown>).status;
		try {
			const updated = updateInvoice(params.id, safeData, locals.user.id);
			if (!updated) return fail(404, { error: st('error.invoiceNotFound') });
			return { success: true };
		} catch (e) {
			const sf = failFromServiceError(e, lang);
			if (sf) return sf;
			console.error('Invoice update failed:', e instanceof Error ? e.message : e);
			return fail(500, { error: st('error.internalError') });
		}
	},

	status: async ({ request, params, locals }) => {
		const lang = getSetting<GeneralSettings>('general').language || 'de';
		const st = serverT(lang);
		if (!locals.user) return fail(401, { error: st('error.notAuthenticated') });

		const formData = await request.formData();
		const status = formData.get('status') as string;
		if (!status) return fail(400, { error: st('error.missingStatus') });

		if (!INVOICE_STATUSES.includes(status as typeof INVOICE_STATUSES[number])) return fail(400, { error: st('error.invalidStatus') });

		try {
			const updated = updateInvoiceStatus(
				params.id,
				status as 'draft' | 'sent' | 'paid' | 'overdue' | 'cancelled',
				locals.user.id
			);
			if (!updated) return fail(404, { error: st('error.invoiceNotFound') });
			return { success: true };
		} catch (e) {
			const sf = failFromServiceError(e, lang);
			if (sf) return sf;
			console.error('Invoice status change failed:', e instanceof Error ? e.message : e);
			return fail(500, { error: st('error.internalError') });
		}
	},

	delete: async ({ params, locals }) => {
		const lang = getSetting<GeneralSettings>('general').language || 'de';
		const st = serverT(lang);
		if (!locals.user) return fail(401, { error: st('error.notAuthenticated') });
		try {
			const removed = removeInvoice(params.id, locals.user.id);
			if (!removed) return fail(404, { error: st('error.invoiceNotFound') });
			throw redirect(302, '/invoices');
		} catch (e) {
			if (isRedirect(e)) throw e;
			const sf = failFromServiceError(e, lang);
			if (sf) return sf;
			console.error('Invoice delete failed:', e instanceof Error ? e.message : e);
			return fail(500, { error: st('error.internalError') });
		}
	},

	duplicate: async ({ params, locals }) => {
		const lang = getSetting<GeneralSettings>('general').language || 'de';
		const st = serverT(lang);
		if (!locals.user) return fail(401, { error: st('error.notAuthenticated') });
		try {
			const dup = duplicateInvoice(params.id, locals.user.id);
			if (!dup) return fail(404, { error: st('error.invoiceNotFound') });
			throw redirect(302, `/invoices/${dup.id}`);
		} catch (e) {
			if (isRedirect(e)) throw e;
			const sf = failFromServiceError(e, lang);
			if (sf) return sf;
			return fail(400, { error: e instanceof Error ? e.message : st('error.duplicationFailed') });
		}
	},

	creditNote: async ({ params, locals }) => {
		const lang = getSetting<GeneralSettings>('general').language || 'de';
		const st = serverT(lang);
		if (!locals.user) return fail(401, { error: st('error.notAuthenticated') });
		try {
			const cn = createCreditNote(params.id, locals.user.id);
			if (!cn) return fail(404, { error: st('error.invoiceNotFound') });
			throw redirect(302, `/invoices/${cn.id}`);
		} catch (e) {
			if (isRedirect(e)) throw e;
			const sf = failFromServiceError(e, lang);
			if (sf) return sf;
			console.error('Credit note creation failed:', e instanceof Error ? e.message : e);
			return fail(500, { error: st('error.internalError') });
		}
	},

	remind: async ({ params, locals }) => {
		const lang = getSetting<GeneralSettings>('general').language || 'de';
		const st = serverT(lang);
		if (!locals.user) return fail(401, { error: st('error.notAuthenticated') });
		try {
			checkAndRecordEmailSend(locals.user.id);
		} catch (e) {
			if (isHttpError(e) && e.status === 429) return fail(429, { error: st('error.tooManyEmails') });
			throw e;
		}
		const invoice = getInvoice(params.id);
		if (!invoice) return fail(404, { error: st('error.invoiceNotFound') });
		if (!invoice.buyer.email) return fail(400, { error: st('error.clientNoEmail') });

		const emailSettings = getSetting<EmailSettings>('emails');
		const tpl = emailSettings.reminderEmail;

		const safeName = invoice.buyer.name.replace(/[\r\n]/g, ' ').replace(/<[^>]*>/g, '');

		const amount = formatMoney(invoice.totals.total, invoice.currency);
		const subject = tpl.subject
			.replace(/{documentId}/g, invoice.documentId)
			.replace(/{clientName}/g, safeName)
			.replace(/{amount}/g, amount);
		const body = tpl.body
			.replace(/{documentId}/g, invoice.documentId)
			.replace(/{clientName}/g, safeName)
			.replace(/{amount}/g, amount);

		try {
			const html = renderDocument(invoice, 'invoice');
			const pdfBuffer = await generatePdf(html);

			await sendEmail({
				to: invoice.buyer.email,
				subject,
				body,
				attachmentBuffer: pdfBuffer,
				attachmentName: `Invoice-${safeFilename(invoice.documentId)}.pdf`
			});
		} catch (e) {
			return fail(502, { error: st('error.reminderSendFailed', { details: sanitizeSmtpError(e) }) });
		}

		try {
			updateInvoice(params.id, { sentTo: invoice.buyer.email }, locals.user.id);
		} catch {
		}

		return { success: true, reminded: true };
	}
};
