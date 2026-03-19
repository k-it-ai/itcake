import {
	db,
	generateId,
	getDocument,
	getDocumentsByType,
	insertDocument,
	updateDocument,
	deleteDocument,
	getSetting,
	incrementCounterWithMin
} from '$lib/server/db.js';
import { recordChange, computeDiff } from '$lib/server/changes.js';
import { computeInvoiceTotals } from '$lib/money.js';
import { resolveIdFormat } from '$lib/id-format.js';
import { getTemplateStrings } from '$lib/server/template-strings.js';
import dayjs from 'dayjs';
import { buildSellerInfo, buildBuyerInfo, zeroTaxRates, recomputeTotals } from '$services/document-helpers.js';
import { getTemplate } from '$services/templates.js';
import type { Invoice, InvoiceStatus, InvoiceSettings, CompanySettings, Client, RecurringConfig, AdvancedSettings } from '$lib/types.js';

/** All valid invoice statuses — single source of truth for route-level validation. */
export const INVOICE_STATUSES: readonly InvoiceStatus[] = ['draft', 'sent', 'paid', 'overdue', 'cancelled'];

// Valid status transitions: key = current status, value = allowed targets
const VALID_TRANSITIONS: Record<InvoiceStatus, InvoiceStatus[]> = {
	draft: ['sent', 'cancelled'],
	sent: ['paid', 'overdue', 'cancelled'],
	overdue: ['paid', 'sent', 'cancelled'],
	paid: ['sent'], // un-pay only (rare correction)
	cancelled: ['draft']
};

/**
 * Validate that a status transition is allowed.
 * Throws an error with a descriptive message if not.
 */
export function validateStatusTransition(currentStatus: InvoiceStatus, newStatus: InvoiceStatus): void {
	const allowed = VALID_TRANSITIONS[currentStatus] ?? [];
	if (!allowed.includes(newStatus)) {
		throw new Error(`Cannot transition from "${currentStatus}" to "${newStatus}"`);
	}
}

/**
 * Check if an invoice is locked from editing based on the editLock setting.
 * 'paid' = lock after paid; 'sent' = lock after sent/paid/overdue/cancelled.
 * Throws if locked.
 */
export function checkEditLock(invoice: Invoice): void {
	const advanced = getSetting<AdvancedSettings>('advanced');
	const lock = advanced.editLock ?? 'none';
	if (lock === 'none') return;
	if (lock === 'paid' && invoice.status === 'paid') {
		throw new Error('This invoice is locked from editing. Change the edit lock setting to modify it.');
	}
	if (lock === 'sent' && ['sent', 'paid', 'overdue', 'cancelled'].includes(invoice.status)) {
		throw new Error('This invoice is locked from editing. Change the edit lock setting to modify it.');
	}
}

/**
 * Check if an invoice is edit-locked (returns boolean, does not throw).
 */
export function isEditLocked(invoice: Invoice): boolean {
	const advanced = getSetting<AdvancedSettings>('advanced');
	const lock = advanced?.editLock ?? 'none';
	if (lock === 'none') return false;
	if (lock === 'paid' && invoice.status === 'paid') return true;
	if (lock === 'sent' && ['sent', 'paid', 'overdue', 'cancelled'].includes(invoice.status)) return true;
	return false;
}

/**
 * Ensure backward compatibility: older invoices may lack invoiceType/linkedInvoiceId.
 */
function ensureInvoiceDefaults(inv: Invoice): Invoice {
	if (!inv.invoiceType) inv.invoiceType = 'invoice';
	if (inv.linkedInvoiceId === undefined) inv.linkedInvoiceId = null;
	return inv;
}

const stmtInvoiceCount = db.prepare("SELECT COUNT(*) as c FROM documents WHERE type = 'invoice'");
const stmtCreditNoteExists = db.prepare(
	"SELECT COUNT(*) as c FROM documents WHERE type = 'invoice' AND json_extract(data, '$.invoiceType') = 'creditNote' AND json_extract(data, '$.linkedInvoiceId') = ?"
);

export function getInvoiceCount(): number {
	return (stmtInvoiceCount.get() as { c: number }).c;
}

export function getInvoices(): Invoice[] {
	return getDocumentsByType<Invoice>('invoice').map(ensureInvoiceDefaults);
}

export function getInvoice(id: string): Invoice | null {
	const inv = getDocument<Invoice>(id, 'invoice');
	return inv ? ensureInvoiceDefaults(inv) : null;
}

// Cached: filtered invoice queries
const stmtInvoicesByStatus = db.prepare(
	"SELECT data FROM documents WHERE type = 'invoice' AND json_extract(data, '$.status') = ? ORDER BY created_at DESC"
);
const stmtInvoicesByClient = db.prepare(
	"SELECT data FROM documents WHERE type = 'invoice' AND json_extract(data, '$.clientId') = ? ORDER BY created_at DESC"
);

export function getInvoicesByStatus(status: InvoiceStatus): Invoice[] {
	const rows = stmtInvoicesByStatus.all(status) as { data: string }[];
	return rows.map((r) => ensureInvoiceDefaults(JSON.parse(r.data)));
}

export function getInvoicesByClient(clientId: string): Invoice[] {
	const rows = stmtInvoicesByClient.all(clientId) as { data: string }[];
	return rows.map((r) => ensureInvoiceDefaults(JSON.parse(r.data)));
}

/**
 * Generate the next document ID based on settings.
 */
function generateDocumentId(settings: InvoiceSettings, clientName?: string): string {
	const format = settings.idFormat;
	const now = new Date();
	const counterKey = 'invoice_global';

	// Atomically ensure counter >= nextNumber and increment
	const counter = incrementCounterWithMin(counterKey, settings.nextNumber);
	return resolveIdFormat(format, counter, now, clientName);
}

export const createInvoice = db.transaction((
	data: {
		invoiceType?: 'invoice' | 'creditNote';
		linkedInvoiceId?: string | null;
		clientId: string;
		pricingMode: 'net' | 'gross';
		currency: string;
		language: string;
		issueDate: string;
		dueDate: string;
		items: Invoice['items'];
		discounts: Invoice['discounts'];
		notes: string;
		footerText: string;
		templateId: string;
		templateOptions: Record<string, unknown>;
		recurring?: RecurringConfig | null;
		kleinunternehmerOverride?: boolean;
	},
	userId: string
): Invoice => {
	const id = generateId();
	const now = new Date().toISOString();

	const invoiceSettings = getSetting<InvoiceSettings>('invoices');
	const companySettings = getSetting<CompanySettings>('company');
	const advanced = getSetting<AdvancedSettings>('advanced');
	const client = getDocument<Client>(data.clientId, 'client');

	if (!client) throw new Error('Client not found');
	if (data.templateId && !getTemplate(data.templateId)) throw new Error('Template not found');

	// Validate linkedInvoiceId references a real invoice (credit note integrity)
	if (data.invoiceType === 'creditNote' && data.linkedInvoiceId) {
		const linked = getDocument<Invoice>(data.linkedInvoiceId, 'invoice');
		if (!linked) throw new Error('Linked invoice not found');
	}

	// For recurring invoices, inherit the source invoice's KU snapshot instead of reading current settings.
	// This ensures a recurring series stays consistent even if the user toggles Kleinunternehmer mid-series.
	const isKleinunternehmer = data.kleinunternehmerOverride !== undefined
		? data.kleinunternehmerOverride
		: advanced?.kleinunternehmer === true;
	const items = isKleinunternehmer ? zeroTaxRates(data.items) : data.items;

	const documentId = generateDocumentId(invoiceSettings, client.name);
	const totals = computeInvoiceTotals(items, data.discounts, data.pricingMode);
	const invoiceType = data.invoiceType ?? 'invoice';
	// linkedInvoiceId only valid for credit notes — nullify for regular invoices
	const linkedInvoiceId = invoiceType === 'creditNote' ? (data.linkedInvoiceId ?? null) : null;

	const invoice: Invoice = {
		id,
		documentId,
		invoiceType,
		linkedInvoiceId,
		clientId: data.clientId,
		status: 'draft',
		pricingMode: data.pricingMode,
		currency: data.currency,
		language: data.language,
		issueDate: data.issueDate,
		dueDate: data.dueDate,
		paidDate: null,
		items,
		discounts: data.discounts,
		notes: data.notes,
		footerText: data.footerText,
		templateId: data.templateId,
		templateOptions: data.templateOptions,
		recurring: data.recurring ?? null,
		kleinunternehmer: isKleinunternehmer ? true : undefined,
		seller: buildSellerInfo(companySettings),
		buyer: buildBuyerInfo(client),
		totals,
		sentAt: null,
		sentTo: null,
		createdAt: now,
		updatedAt: now
	};

	insertDocument(id, 'invoice', invoice);
	recordChange(invoiceType === 'creditNote' ? 'creditNote' : 'invoice', id, 'create', {}, userId);

	return invoice;
});

export function updateInvoice(
	id: string,
	data: Partial<Invoice>,
	userId: string
): Invoice | null {
	return db.transaction(() => {
		const existing = getDocument<Invoice>(id, 'invoice');
		if (!existing) return null;

		checkEditLock(existing);

		// Validate status transition if status is changing
		let paidDate: string | null | undefined;
		let sentAt: string | undefined;
		if (data.status && data.status !== existing.status) {
			validateStatusTransition(existing.status, data.status);
			// Handle paidDate side effect for consistency with updateInvoiceStatus
			if (data.status === 'paid') {
				paidDate = dayjs().format('YYYY-MM-DD');
			} else if (existing.status === 'paid') {
				paidDate = null;
			}
			// Record first sent timestamp
			if (data.status === 'sent' && !existing.sentAt) {
				sentAt = new Date().toISOString();
			}
		}

		// Validate date consistency: dueDate must not be before issueDate
		const effectiveIssueDate = data.issueDate ?? existing.issueDate;
		const effectiveDueDate = data.dueDate ?? existing.dueDate;
		if (effectiveDueDate < effectiveIssueDate) {
			throw new Error('Cannot set due date before issue date');
		}

		const { totals, resolvedItems } = recomputeTotals(existing, data);

		// If client changed, rebuild buyer info
		let buyer = existing.buyer;
		if (data.clientId && data.clientId !== existing.clientId) {
			const client = getDocument<Client>(data.clientId, 'client');
			if (!client) throw new Error('Client not found');
			buyer = buildBuyerInfo(client);
		}

		// Strip immutable/snapshot fields and status from caller data
		// Status changes must go through validateStatusTransition above
		// invoiceType is immutable — changing invoice→creditNote post-creation would bypass the credit note workflow
		const { seller: _s, buyer: _b, totals: _t, documentId: _d, createdAt: _c, id: _id, paidDate: _pd, sentAt: _sa, status: _st, kleinunternehmer: _ku, invoiceType: _it, linkedInvoiceId: _li, recurring: _r, ...safeData } = data;

		const updated: Invoice = {
			...existing,
			...safeData,
			id: existing.id,
			documentId: existing.documentId,
			...(resolvedItems ? { items: resolvedItems } : {}),
			// Apply validated status change (if any)
			...(data.status && data.status !== existing.status ? { status: data.status } : {}),
			buyer,
			totals,
			...(paidDate !== undefined ? { paidDate } : {}),
			...(sentAt !== undefined ? { sentAt } : {}),
			createdAt: existing.createdAt,
			updatedAt: new Date().toISOString()
		};

		const diff = computeDiff(
			existing as unknown as Record<string, unknown>,
			updated as unknown as Record<string, unknown>
		);

		updateDocument(id, updated);
		const entityType = (updated.invoiceType === 'creditNote') ? 'creditNote' : 'invoice';
		recordChange(entityType, id, 'update', diff, userId);

		return updated;
	})();
}

export function updateInvoiceStatus(
	id: string,
	status: Invoice['status'],
	userId: string
): Invoice | null {
	return db.transaction(() => {
		const existing = getDocument<Invoice>(id, 'invoice');
		if (!existing) return null;

		// Edit lock applies to content changes, not status transitions.
		// Marking an invoice as paid/sent is a normal workflow that should not be blocked.
		validateStatusTransition(existing.status, status);

		const update: Partial<Invoice> = { status };
		if (status === 'paid') {
			update.paidDate = dayjs().format('YYYY-MM-DD');
		} else if (existing.status === 'paid') {
			update.paidDate = null;
		}
		if (status === 'sent' && !existing.sentAt) {
			update.sentAt = new Date().toISOString();
		}

		// Reopening a cancelled invoice: record as explicit 'reopen' action so the
		// audit trail distinguishes intentional re-openings from normal transitions.
		// This makes it visible that the invoice was previously cancelled and revived.
		const action = (existing.status === 'cancelled' && status === 'draft') ? 'reopen' : 'status_change';

		const updated = { ...existing, ...update, updatedAt: new Date().toISOString() };
		updateDocument(id, updated);
		const entityType = (existing.invoiceType === 'creditNote') ? 'creditNote' : 'invoice';
		recordChange(entityType, id, action, {
			status: { old: existing.status, new: status }
		}, userId);

		return updated;
	})();
}

export function removeInvoice(id: string, userId: string): boolean {
	return db.transaction(() => {
		const existing = getDocument<Invoice>(id, 'invoice');
		if (!existing) return false;

		checkEditLock(existing);

		// Block deletion of non-draft credit notes — they are accounting documents
		// that serve as audit trail for invoice reversals
		if (existing.invoiceType === 'creditNote' && existing.status !== 'draft') {
			throw new Error('Cannot delete a non-draft credit note. Only draft credit notes can be deleted.');
		}

		// Block deletion if credit notes reference this invoice — orphaned credit
		// notes would break the audit trail for invoice reversals
		if (existing.invoiceType !== 'creditNote') {
			const cnCount = (stmtCreditNoteExists.get(id) as { c: number }).c;
			if (cnCount > 0) {
				throw new Error('Cannot delete this invoice because it has linked credit notes. Delete the credit notes first.');
			}
		}

		deleteDocument(id);
		const entityType = (existing.invoiceType === 'creditNote') ? 'creditNote' : 'invoice';
		recordChange(entityType, id, 'delete', {}, userId);
		return true;
	})();
}

/**
 * Duplicate an invoice — creates a new draft with a fresh document ID.
 * Wrapped in a transaction so the read + counter increment + insert are atomic.
 */
export const duplicateInvoice = db.transaction((id: string, userId: string): Invoice | null => {
	const source = getDocument<Invoice>(id, 'invoice');
	if (!source) return null;
	if (source.invoiceType === 'creditNote') {
		throw new Error('Cannot duplicate a credit note. Create a new credit note from the original invoice instead.');
	}

	const rawDaysDiff = dayjs(source.dueDate).diff(dayjs(source.issueDate), 'day');
	const fallbackDays = getSetting<InvoiceSettings>('invoices').defaultPaymentTermDays ?? 30;
	const daysDiff = rawDaysDiff >= 0 ? rawDaysDiff : fallbackDays;
	const today = dayjs();

	return createInvoice({
		clientId: source.clientId,
		pricingMode: source.pricingMode,
		currency: source.currency,
		language: source.language,
		issueDate: today.format('YYYY-MM-DD'),
		dueDate: today.add(daysDiff, 'day').format('YYYY-MM-DD'),
		items: structuredClone(source.items),
		discounts: structuredClone(source.discounts),
		notes: source.notes,
		footerText: source.footerText,
		templateId: source.templateId,
		templateOptions: structuredClone(source.templateOptions),
		recurring: null
	}, userId);
});

/**
 * Create a credit note that reverses an existing invoice.
 * Items are cloned with negated quantities to produce negative totals.
 * Wrapped in a transaction so the status check + counter increment + insert are atomic.
 */
export const createCreditNote = db.transaction((invoiceId: string, userId: string): Invoice | null => {
	const source = getDocument<Invoice>(invoiceId, 'invoice');
	if (!source) return null;
	if (source.invoiceType === 'creditNote') throw new Error('Cannot create a credit note for a credit note');
	if (source.status === 'draft' || source.status === 'cancelled') {
		throw new Error('Credit notes can only be created for sent, paid, or overdue invoices');
	}

	// Prevent duplicate full-reversal credit notes for the same invoice
	const existingCount = (stmtCreditNoteExists.get(invoiceId) as { c: number }).c;
	if (existingCount > 0) {
		throw new Error('A credit note already exists for this invoice');
	}

	// Negate quantities to produce negative amounts
	const negatedItems = structuredClone(source.items).map(function negateItem(item: Invoice['items'][0]): Invoice['items'][0] {
		return {
			...item,
			quantity: -Math.abs(item.quantity),
			items: item.items.map(negateItem)
		};
	});

	// Carry over discounts as-is — values stay positive (satisfying the Zod min(0) constraint).
	// computeDiscountAmount handles the sign automatically based on the subtotal direction:
	// percentage discounts produce negative amounts from the negative subtotal, and fixed
	// discounts are sign-matched to the subtotal so they reduce the credit magnitude.
	const negatedDiscounts = structuredClone(source.discounts);

	const creditNoteDate = dayjs().format('YYYY-MM-DD');
	return createInvoice({
		invoiceType: 'creditNote',
		linkedInvoiceId: source.id,
		clientId: source.clientId,
		pricingMode: source.pricingMode,
		currency: source.currency,
		language: source.language,
		issueDate: creditNoteDate,
		dueDate: creditNoteDate,
		items: negatedItems,
		discounts: negatedDiscounts,
		notes: (getTemplateStrings(source.language).creditNoteFor ?? 'Credit note for {documentId}').replace('{documentId}', source.documentId),
		footerText: source.footerText,
		templateId: source.templateId,
		templateOptions: structuredClone(source.templateOptions),
		recurring: null
	}, userId);
});

// Cached: overdue candidate query (sent invoices past due date, excluding credit notes)
const stmtOverdueCandidates = db.prepare(`
	SELECT data FROM documents
	WHERE type = 'invoice'
	  AND json_extract(data, '$.status') = 'sent'
	  AND json_extract(data, '$.dueDate') < ?
	  AND COALESCE(json_extract(data, '$.invoiceType'), 'invoice') != 'creditNote'
`);

/**
 * Mark all sent invoices past their due date as overdue.
 * Batched in a single transaction for one WAL commit instead of N.
 * Individual per-invoice try/catch ensures a single failure doesn't roll back the batch.
 */
export function markOverdueInvoices(userId: string): number {
	const today = dayjs().format('YYYY-MM-DD');
	const rows = stmtOverdueCandidates.all(today) as { data: string }[];
	if (rows.length === 0) return 0;

	// Each updateInvoiceStatus has its own transaction — no outer wrapper needed.
	// An outer transaction would cause stale SSE events if any inner savepoint rolls back.
	let count = 0;
	for (const row of rows) {
		const inv = JSON.parse(row.data) as Invoice;
		try {
			// Re-read to close TOCTOU gap: due date may have been extended since the query
			const fresh = getDocument<Invoice>(inv.id, 'invoice');
			if (!fresh || fresh.status !== 'sent' || fresh.dueDate >= today) continue;
			updateInvoiceStatus(inv.id, 'overdue', userId);
			count++;
		} catch (e) {
			console.error(`Failed to mark invoice ${inv.id} overdue:`, e);
		}
	}
	return count;
}

