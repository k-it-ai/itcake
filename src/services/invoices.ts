import {
	db,
	generateId,
	getDocument,
	getDocumentsByType,
	insertDocument,
	updateDocument,
	deleteDocument,
	getSetting,
	queryDocumentsPaginated,
	escapeSqlLike
} from '$lib/server/db.js';
import type { PaginatedResult } from '$lib/server/db.js';
import { recordChange, computeDiff } from '$lib/server/changes.js';
import { computeInvoiceTotals } from '$lib/money.js';
import { generateNumberedId } from '$lib/server/numbered-id.js';
import { getTemplateStrings } from '$lib/server/template-strings.js';
import dayjs from 'dayjs';
import { buildSellerInfo, buildBuyerInfo, zeroTaxRates, recomputeTotals, pickFields, validateTransition } from '$services/document-helpers.js';
import { getTemplate } from '$services/templates.js';
import { serverT } from '$lib/i18n/server.js';
import { sanitizeRichText } from '$lib/server/sanitize.js';
import { ServiceError } from '$lib/server/service-error.js';
import type { Invoice, InvoiceStatus, InvoiceSettings, CompanySettings, Client, GeneralSettings, RecurringConfig, AdvancedSettings } from '$lib/types.js';

export const INVOICE_STATUSES: readonly InvoiceStatus[] = ['draft', 'sent', 'paid', 'overdue', 'cancelled'];

const INVOICE_MUTABLE_FIELDS = new Set<keyof Invoice>([
	'clientId', 'pricingMode', 'currency', 'language',
	'issueDate', 'dueDate', 'items', 'discounts',
	'notes', 'footerText', 'templateId', 'templateOptions', 'sentTo'
]);

const INVOICE_FROZEN_AFTER_SEND = new Set<keyof Invoice>([
	'clientId', 'currency', 'pricingMode'
]);

export const VALID_TRANSITIONS: Record<InvoiceStatus, InvoiceStatus[]> = {
	draft: ['sent', 'cancelled'],
	sent: ['paid', 'overdue', 'cancelled'],
	overdue: ['paid', 'sent', 'cancelled'],
	paid: ['sent'],
	cancelled: ['draft']
};


export function isEditLocked(invoice: Invoice): boolean {
	const advanced = getSetting<AdvancedSettings>('advanced');
	const lock = advanced?.editLock ?? 'none';
	if (lock === 'none') return false;
	if (lock === 'paid' && invoice.status === 'paid') return true;
	if (lock === 'sent' && ['sent', 'paid', 'overdue', 'cancelled'].includes(invoice.status)) return true;
	return false;
}

function checkEditLock(invoice: Invoice): void {
	if (isEditLocked(invoice)) {
		throw new ServiceError('error.invoiceEditLocked');
	}
}

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

const stmtStatusCounts = db.prepare(`
  SELECT json_extract(data, '$.status') as status, COUNT(*) as count
  FROM documents WHERE type = 'invoice'
  AND json_extract(data, '$.invoiceType') != 'creditNote'
  GROUP BY status
`);

const stmtCreditNoteCount = db.prepare(
	"SELECT COUNT(*) as c FROM documents WHERE type = 'invoice' AND json_extract(data, '$.invoiceType') = 'creditNote'"
);

const stmtMonthlyRevenue = db.prepare(`
  SELECT
    CAST(strftime('%m', COALESCE(json_extract(data, '$.paidDate'), json_extract(data, '$.issueDate'))) AS INTEGER) - 1 as month,
    SUM(json_extract(data, '$.totals.total')) as revenue,
    SUM(json_extract(data, '$.totals.totalTaxes')) as taxes
  FROM documents
  WHERE type = 'invoice'
    AND json_extract(data, '$.invoiceType') != 'creditNote'
    AND json_extract(data, '$.status') = 'paid'
    AND json_extract(data, '$.currency') = ?
    -- Both paidDate AND issueDate NULL would bucket to month=NaN and
    -- silently disappear from totals. Migrated rows have paidDate, but
    -- a manual / restored insert could slip through.
    AND COALESCE(json_extract(data, '$.paidDate'), json_extract(data, '$.issueDate')) IS NOT NULL
    AND strftime('%Y', COALESCE(json_extract(data, '$.paidDate'), json_extract(data, '$.issueDate'))) = ?
  GROUP BY month
`);

const stmtUnpaidInvoices = db.prepare(`
  SELECT data FROM documents
  WHERE type = 'invoice'
    AND json_extract(data, '$.invoiceType') != 'creditNote'
    AND json_extract(data, '$.status') IN ('sent', 'overdue')
  ORDER BY json_extract(data, '$.dueDate') ASC
  LIMIT 10
`);

const stmtUnpaidTotal = db.prepare(`
  SELECT SUM(json_extract(data, '$.totals.total')) as total, COUNT(*) as count
  FROM documents
  WHERE type = 'invoice'
    AND json_extract(data, '$.invoiceType') != 'creditNote'
    AND json_extract(data, '$.status') IN ('sent', 'overdue')
    AND json_extract(data, '$.currency') = ?
`);

const stmtTopClients = db.prepare(`
  SELECT
    (
      SELECT json_extract(d.data, '$.buyer.name')
      FROM documents d
      WHERE d.type = 'invoice'
        AND json_extract(d.data, '$.clientId') = json_extract(documents.data, '$.clientId')
        AND json_extract(d.data, '$.status') = 'paid'
        AND json_extract(d.data, '$.invoiceType') != 'creditNote'
      ORDER BY COALESCE(json_extract(d.data, '$.paidDate'), json_extract(d.data, '$.issueDate')) DESC
      LIMIT 1
    ) as name,
    SUM(json_extract(data, '$.totals.total')) as total
  FROM documents
  WHERE type = 'invoice'
    AND json_extract(data, '$.invoiceType') != 'creditNote'
    AND json_extract(data, '$.status') = 'paid'
    AND json_extract(data, '$.currency') = ?
  GROUP BY json_extract(data, '$.clientId')
  ORDER BY total DESC
  LIMIT 3
`);

const stmtRecentInvoices = db.prepare(`
  SELECT data FROM documents
  WHERE type = 'invoice'
    AND json_extract(data, '$.invoiceType') != 'creditNote'
  ORDER BY created_at DESC
  LIMIT 5
`);

const stmtRecentProposals = db.prepare(
	"SELECT data FROM documents WHERE type = 'proposal' ORDER BY created_at DESC LIMIT 5"
);

export function getDashboardStats(currency: string, year: number, isKleinunternehmer: boolean) {
	const statusRows = stmtStatusCounts.all() as { status: string; count: number }[];
	const statusMap: Record<string, number> = {};
	for (const r of statusRows) statusMap[r.status] = r.count;
	const creditNoteCount = (stmtCreditNoteCount.get() as { c: number }).c;
	const totalInvoices = Object.values(statusMap).reduce((a, b) => a + b, 0);

	const monthlyRevenue: number[] = Array(12).fill(0);
	const monthlyTax: number[] = Array(12).fill(0);
	const revenueRows = stmtMonthlyRevenue.all(currency, String(year)) as { month: number; revenue: number; taxes: number }[];
	for (const r of revenueRows) {
		monthlyRevenue[r.month] = r.revenue || 0;
		if (!isKleinunternehmer) monthlyTax[r.month] = r.taxes || 0;
	}

	const unpaidRows = stmtUnpaidInvoices.all() as { data: string }[];
	const unpaidInvoices = unpaidRows.map(r => ensureInvoiceDefaults(JSON.parse(r.data)));
	const unpaidTotalRow = stmtUnpaidTotal.get(currency) as { total: number | null; count: number };

	const topClients = (stmtTopClients.all(currency) as { name: string; total: number }[])
		.map(r => ({ name: r.name || serverT(getSetting<GeneralSettings>('general').language || 'en')('search.unknownClient'), total: r.total }));

	const recentInvoices = (stmtRecentInvoices.all() as { data: string }[]).map(r => ensureInvoiceDefaults(JSON.parse(r.data)));
	const recentProposals = (stmtRecentProposals.all() as { data: string }[]).map(r => JSON.parse(r.data));

	return {
		stats: {
			totalDraft: statusMap['draft'] || 0,
			totalSent: statusMap['sent'] || 0,
			totalPaid: statusMap['paid'] || 0,
			totalOverdue: statusMap['overdue'] || 0,
			totalInvoices,
			totalCreditNotes: creditNoteCount
		},
		monthlyRevenue,
		monthlyTax,
		unpaidInvoices,
		totalUnpaid: unpaidTotalRow.total || 0,
		unpaidCount: unpaidTotalRow.count,
		topClients,
		recentInvoices,
		recentProposals
	};
}

export function getInvoices(): Invoice[] {
	return getDocumentsByType<Invoice>('invoice').map(ensureInvoiceDefaults);
}

export function getInvoice(id: string): Invoice | null {
	const inv = getDocument<Invoice>(id, 'invoice');
	return inv ? ensureInvoiceDefaults(inv) : null;
}

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

	if (data.invoiceType === 'creditNote' && data.linkedInvoiceId) {
		const linked = getDocument<Invoice>(data.linkedInvoiceId, 'invoice');
		if (!linked) throw new Error('Linked invoice not found');
	}

	const isKleinunternehmer = data.kleinunternehmerOverride !== undefined
		? data.kleinunternehmerOverride
		: advanced?.kleinunternehmer === true;
	// sanitize-html the rich-text fields on the way into the store, not
	// just on the way out via the PDF template. GET /api/invoices and the
	// AI tool surface (get_invoice) both read these fields directly; if
	// `<a>` ever joins the allowedTags, an unsanitized stored `javascript:`
	// href would survive. Same posture tickets has used since pass 1.
	const sanitizedItems = data.items.map(it => ({
		...it,
		description: it.description ? sanitizeRichText(it.description) : it.description
	}));
	const items = isKleinunternehmer ? zeroTaxRates(sanitizedItems) : sanitizedItems;

	const documentId = generateNumberedId('invoice_global', invoiceSettings, client.name);
	const totals = computeInvoiceTotals(items, data.discounts, data.pricingMode);
	const invoiceType = data.invoiceType ?? 'invoice';
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
		notes: data.notes ? sanitizeRichText(data.notes) : data.notes,
		footerText: data.footerText ? sanitizeRichText(data.footerText) : data.footerText,
		templateId: data.templateId,
		templateOptions: data.templateOptions,
		recurring: data.recurring
			? {
				...data.recurring,
				anchorDay: data.recurring.anchorDay ?? dayjs(data.recurring.nextRunDate).date()
			}
			: null,
		kleinunternehmer: isKleinunternehmer,
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

		const effectiveIssueDate = data.issueDate ?? existing.issueDate;
		const effectiveDueDate = data.dueDate ?? existing.dueDate;
		if (effectiveDueDate < effectiveIssueDate) {
			throw new ServiceError('error.dueDateBeforeIssueDate');
		}

		const { totals, resolvedItems } = recomputeTotals(existing, data);

		let buyer = existing.buyer;
		if (data.clientId && data.clientId !== existing.clientId) {
			const client = getDocument<Client>(data.clientId, 'client');
			if (!client) throw new Error('Client not found');
			buyer = buildBuyerInfo(client);
		}

		const safeData = pickFields(data, INVOICE_MUTABLE_FIELDS);

		// Mirror createInvoice — sanitize the rich-text fields at write time
		// so GET /api/invoices and the AI tool surface never serve raw HTML.
		if ('notes' in safeData && typeof safeData.notes === 'string' && safeData.notes) {
			safeData.notes = sanitizeRichText(safeData.notes);
		}
		if ('footerText' in safeData && typeof safeData.footerText === 'string' && safeData.footerText) {
			safeData.footerText = sanitizeRichText(safeData.footerText);
		}
		const sanitizedResolvedItems = resolvedItems
			? resolvedItems.map(it => ({
				...it,
				description: it.description ? sanitizeRichText(it.description) : it.description
			}))
			: undefined;

		if (existing.sentAt) {
			for (const f of INVOICE_FROZEN_AFTER_SEND) {
				if (f in safeData && safeData[f] !== existing[f]) {
					throw new ServiceError('error.invoiceFieldFrozenAfterSend');
				}
			}
		}

		const updated: Invoice = {
			...existing,
			...safeData,
			id: existing.id,
			documentId: existing.documentId,
			...(sanitizedResolvedItems ? { items: sanitizedResolvedItems } : {}),
			buyer,
			totals,
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

		validateTransition(VALID_TRANSITIONS, existing.status, status);

		if (existing.status === 'paid' && status !== 'paid' && isEditLocked(existing)) {
			throw new ServiceError('error.invoiceEditLocked');
		}

		const update: Partial<Invoice> = { status };
		if (status === 'paid') {
			update.paidDate = dayjs().format('YYYY-MM-DD');
		} else if (existing.status === 'paid') {
			update.paidDate = null;
		}
		if (status === 'sent' && !existing.sentAt) {
			update.sentAt = new Date().toISOString();
		}

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

		if (existing.invoiceType === 'creditNote' && existing.status !== 'draft') {
			throw new ServiceError('error.cannotDeleteNonDraftCreditNote');
		}

		if (existing.invoiceType !== 'creditNote') {
			const cnCount = (stmtCreditNoteExists.get(id) as { c: number }).c;
			if (cnCount > 0) {
				throw new ServiceError('error.invoiceHasLinkedCreditNotes');
			}
		}

		const linkedTickets = db.prepare(
			"SELECT id, data FROM documents WHERE type = 'ticket' AND json_extract(data, '$.invoiceId') = ?"
		).all(id) as { id: string; data: string }[];
		for (const row of linkedTickets) {
			const ticket = JSON.parse(row.data);
			const oldStatus = ticket.status;
			ticket.status = 'completed';
			ticket.invoiceId = null;
			ticket.updatedAt = new Date().toISOString();
			updateDocument(row.id, ticket);
			recordChange('ticket', row.id, 'status_change', {
				status: { old: oldStatus, new: 'completed' },
				invoiceId: { old: id, new: null }
			}, userId);
		}

		deleteDocument(id);
		const entityType = (existing.invoiceType === 'creditNote') ? 'creditNote' : 'invoice';
		recordChange(entityType, id, 'delete', {}, userId);
		return true;
	})();
}

export const duplicateInvoice = db.transaction((id: string, userId: string): Invoice | null => {
	const source = getDocument<Invoice>(id, 'invoice');
	if (!source) return null;
	if (source.invoiceType === 'creditNote') {
		throw new ServiceError('error.cannotDuplicateCreditNote');
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

export const createCreditNote = db.transaction((invoiceId: string, userId: string): Invoice | null => {
	const source = getDocument<Invoice>(invoiceId, 'invoice');
	if (!source) return null;
	if (source.invoiceType === 'creditNote') throw new ServiceError('error.cannotCreateCreditNoteForCreditNote');
	if (source.status === 'draft' || source.status === 'cancelled') {
		throw new ServiceError('error.creditNoteOnlyForSentPaidOverdue');
	}

	// One-shot gate: refuse a re-issue if a credit note has EVER been issued
	// for this source invoice, regardless of whether that earlier note has
	// since been deleted. The old `stmtCreditNoteExists` check counted only
	// live rows, so `createCreditNote → removeInvoice(draft) → createCreditNote`
	// looped unboundedly. The persistent `creditNoteIssuedAt` field stays
	// set across deletes. Backward-compat: pre-fix invoices without the
	// field fall through to the live-row check.
	if (source.creditNoteIssuedAt) {
		throw new ServiceError('error.creditNoteAlreadyExists');
	}
	const existingCount = (stmtCreditNoteExists.get(invoiceId) as { c: number }).c;
	if (existingCount > 0) {
		throw new ServiceError('error.creditNoteAlreadyExists');
	}

	const negatedItems = structuredClone(source.items).map(function negateItem(item: Invoice['items'][0]): Invoice['items'][0] {
		return {
			...item,
			quantity: -Math.abs(item.quantity),
			items: item.items.map(negateItem)
		};
	});

	const negatedDiscounts = structuredClone(source.discounts);

	const creditNoteDate = dayjs().format('YYYY-MM-DD');
	const creditNote = createInvoice({
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

	// Sticky-mark the source AFTER successful create. Inside the same
	// `db.transaction` wrapper so a crash between createInvoice + this
	// update rolls both back. Never set when `creditNote === null`
	// (createInvoice signals a recoverable refusal that way).
	if (creditNote) {
		const updated: Invoice = { ...source, creditNoteIssuedAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
		updateDocument(source.id, updated);
	}
	return creditNote;
});

const stmtOverdueCandidates = db.prepare(`
	SELECT data FROM documents
	WHERE type = 'invoice'
	  AND json_extract(data, '$.status') = 'sent'
	  AND json_extract(data, '$.dueDate') < ?
	  AND COALESCE(json_extract(data, '$.invoiceType'), 'invoice') != 'creditNote'
`);

export function markOverdueInvoices(userId: string): number {
	const timezone = getSetting<GeneralSettings>('general').timezone || 'UTC';
	const today = new Date().toLocaleDateString('sv-SE', { timeZone: timezone });
	const rows = stmtOverdueCandidates.all(today) as { data: string }[];
	if (rows.length === 0) return 0;

	let count = 0;
	for (const row of rows) {
		const inv = JSON.parse(row.data) as Invoice;
		try {
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

interface InvoiceFilters {
	status?: string;
	clientName?: string;
	search?: string;
	dateFrom?: string;
	dateTo?: string;
}

export function getInvoicesPaginated(filters: InvoiceFilters = {}, page = 1, pageSize = 25): PaginatedResult<Invoice> {
	const queryFilters: Array<{ sql: string; params: unknown[] }> = [];

	if (filters.status) {
		queryFilters.push({ sql: "json_extract(data, '$.status') = ?", params: [filters.status] });
	}
	if (filters.clientName) {
		queryFilters.push({ sql: "json_extract(data, '$.buyer.name') = ?", params: [filters.clientName] });
	}
	if (filters.search) {
		const q = `%${escapeSqlLike(filters.search)}%`;
		queryFilters.push({
			sql: "(json_extract(data, '$.documentId') LIKE ? ESCAPE '\\' OR json_extract(data, '$.buyer.name') LIKE ? ESCAPE '\\')",
			params: [q, q]
		});
	}
	if (filters.dateFrom) {
		queryFilters.push({ sql: "json_extract(data, '$.issueDate') >= ?", params: [filters.dateFrom] });
	}
	if (filters.dateTo) {
		queryFilters.push({ sql: "json_extract(data, '$.issueDate') <= ?", params: [filters.dateTo] });
	}

	const result = queryDocumentsPaginated<Invoice>('invoice', { filters: queryFilters, page, pageSize });
	result.items = result.items.map(ensureInvoiceDefaults);
	return result;
}

const stmtDistinctClientNames = db.prepare(
	"SELECT DISTINCT json_extract(data, '$.buyer.name') as name FROM documents WHERE type = 'invoice' AND json_extract(data, '$.buyer.name') IS NOT NULL ORDER BY name"
);

export function getDistinctClientNames(): string[] {
	return (stmtDistinctClientNames.all() as { name: string }[]).map(r => r.name).filter(Boolean);
}
