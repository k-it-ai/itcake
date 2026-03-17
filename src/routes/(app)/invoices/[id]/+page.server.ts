import type { Actions, PageServerLoad } from './$types.js';
import { redirect, fail, error, isRedirect, isHttpError } from '@sveltejs/kit';
import { getInvoice, updateInvoice, updateInvoiceStatus, removeInvoice, duplicateInvoice, createCreditNote, isEditLocked, INVOICE_STATUSES } from '$services/invoices.js';
import { getClients } from '$services/clients.js';
import { getTemplates } from '$services/templates.js';
import { getCatalogItems } from '$services/catalog-items.js';
import { sendEmail } from '$services/emails.js';
import { renderDocument } from '$lib/server/template-renderer.js';
import { generatePdf } from '$lib/server/pdf.js';
import { getSetting } from '$lib/server/db.js';
import { safeFilename, sanitizeSmtpError } from '$lib/server/sanitize.js';
import { checkEmailRateLimit, recordEmailSend } from '$lib/server/rate-limit.js';
import type { EmailSettings, AdvancedSettings, InvoiceSettings } from '$lib/types.js';
import { updateInvoiceSchema } from '$lib/validators.js';
import { formatMoney } from '$lib/money.js';

export const load: PageServerLoad = async ({ params, locals }) => {
	if (!locals.user) throw redirect(302, '/login');
	const invoice = getInvoice(params.id);
	if (!invoice) throw error(404, 'Invoice not found');

	const emailSettings = getSetting<EmailSettings>('emails');
	const advanced = getSetting<AdvancedSettings>('advanced');
	const invoiceSettings = getSetting<InvoiceSettings>('invoices');

	return {
		invoice,
		editLocked: isEditLocked(invoice),
		clients: getClients(),
		templates: getTemplates(),
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
		if (!locals.user) return fail(401, { error: 'Not authenticated' });

		const formData = await request.formData();
		const rawData = formData.get('data') as string;
		if (!rawData) return fail(400, { error: 'Missing data' });

		let data: Record<string, unknown>;
		try { data = JSON.parse(rawData); } catch { return fail(400, { error: 'Invalid JSON' }); }

		const validated = updateInvoiceSchema.safeParse(data);
		if (!validated.success) return fail(400, { error: validated.error.issues[0].message });

		// Strip status — status changes must go through the dedicated ?/status action
		const { status: _ignoredStatus, ...safeData } = validated.data;
		try {
			const updated = updateInvoice(params.id, safeData, locals.user.id);
			if (!updated) return fail(404, { error: 'Invoice not found' });
			return { success: true };
		} catch (e) {
			if (e instanceof Error && e.message.includes('locked')) return fail(403, { error: e.message });
			return fail(500, { error: 'Internal error' });
		}
	},

	status: async ({ request, params, locals }) => {
		if (!locals.user) return fail(401, { error: 'Not authenticated' });

		const formData = await request.formData();
		const status = formData.get('status') as string;
		if (!status) return fail(400, { error: 'Missing status' });

		if (!INVOICE_STATUSES.includes(status as typeof INVOICE_STATUSES[number])) return fail(400, { error: 'Invalid status' });

		try {
			const updated = updateInvoiceStatus(
				params.id,
				status as 'draft' | 'sent' | 'paid' | 'overdue' | 'cancelled',
				locals.user.id
			);
			if (!updated) return fail(404, { error: 'Invoice not found' });
			return { success: true };
		} catch (e) {
			if (e instanceof Error && e.message.includes('locked')) return fail(403, { error: e.message });
			if (e instanceof Error && e.message.includes('Cannot transition')) return fail(400, { error: e.message });
			return fail(500, { error: 'Internal error' });
		}
	},

	delete: async ({ params, locals }) => {
		if (!locals.user) return fail(401, { error: 'Not authenticated' });
		try {
			const removed = removeInvoice(params.id, locals.user.id);
			if (!removed) return fail(404, { error: 'Invoice not found' });
			throw redirect(302, '/invoices');
		} catch (e) {
			if (isRedirect(e)) throw e;
			if (e instanceof Error && e.message.includes('locked')) return fail(403, { error: e.message });
			return fail(500, { error: 'Internal error' });
		}
	},

	duplicate: async ({ params, locals }) => {
		if (!locals.user) return fail(401, { error: 'Not authenticated' });
		try {
			const dup = duplicateInvoice(params.id, locals.user.id);
			if (!dup) return fail(404, { error: 'Invoice not found' });
			throw redirect(302, `/invoices/${dup.id}`);
		} catch (e) {
			if (isRedirect(e)) throw e;
			return fail(400, { error: e instanceof Error ? e.message : 'Duplication failed' });
		}
	},

	creditNote: async ({ params, locals }) => {
		if (!locals.user) return fail(401, { error: 'Not authenticated' });
		try {
			const cn = createCreditNote(params.id, locals.user.id);
			if (!cn) return fail(404, { error: 'Invoice not found' });
			throw redirect(302, `/invoices/${cn.id}`);
		} catch (e) {
			if (isRedirect(e)) throw e;
			const msg = e instanceof Error ? e.message : '';
			if (/credit note|Cannot create|Cannot transition|locked/i.test(msg)) {
				return fail(400, { error: msg });
			}
			console.error('Credit note creation failed:', msg);
			return fail(500, { error: 'Internal error' });
		}
	},

	remind: async ({ params, locals }) => {
		if (!locals.user) return fail(401, { error: 'Not authenticated' });
		try {
			checkEmailRateLimit(locals.user.id);
		} catch (e) {
			if (isHttpError(e) && e.status === 429) return fail(429, { error: 'Too many emails. Please try again later.' });
			throw e;
		}
		const invoice = getInvoice(params.id);
		if (!invoice) return fail(404, { error: 'Invoice not found' });
		if (!invoice.buyer.email) return fail(400, { error: 'Client has no email address' });

		const emailSettings = getSetting<EmailSettings>('emails');
		const tpl = emailSettings.reminderEmail;

		// Sanitize client name: strip newlines (header injection) and HTML tags
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

		// Record attempt before SMTP call — prevents unlimited retry abuse against the relay
		recordEmailSend(locals.user.id);

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
			return fail(502, { error: `Failed to send reminder: ${sanitizeSmtpError(e)}` });
		}

		try {
			updateInvoice(params.id, { sentTo: invoice.buyer.email }, locals.user.id);
		} catch {
			// Edit lock may prevent update; email already sent, don't fail
		}

		return { success: true, reminded: true };
	}
};
