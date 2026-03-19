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
import { createInvoice } from '$services/invoices.js';
import { getTemplate } from '$services/templates.js';
import { buildSellerInfo, buildBuyerInfo, zeroTaxRates, recomputeTotals, pickFields } from '$services/document-helpers.js';
import dayjs from 'dayjs';
import type { Proposal, ProposalStatus, ProposalSettings, InvoiceSettings, CompanySettings, Client, Invoice, AdvancedSettings } from '$lib/types.js';

/** All valid proposal statuses — single source of truth for route-level validation. */
export const PROPOSAL_STATUSES: readonly ProposalStatus[] = ['draft', 'sent', 'accepted', 'rejected', 'expired'];

/**
 * Fields that updateProposal is allowed to pass through from caller data.
 * Everything else (id, documentId, seller, buyer, totals, status, sentAt,
 * sentTo, kleinunternehmer, createdAt) is managed internally.
 * When adding a new editable field to Proposal, add it here.
 */
const PROPOSAL_MUTABLE_FIELDS = new Set<keyof Proposal>([
	'clientId', 'pricingMode', 'currency', 'language',
	'issueDate', 'validUntil', 'items', 'discounts',
	'introText', 'notes', 'footerText', 'templateId', 'templateOptions'
]);

const VALID_PROPOSAL_TRANSITIONS: Record<ProposalStatus, ProposalStatus[]> = {
	draft: ['sent'],
	sent: ['accepted', 'rejected', 'expired'],
	accepted: [],
	rejected: ['draft'],
	expired: ['draft']
};

export function validateProposalStatusTransition(currentStatus: ProposalStatus, newStatus: ProposalStatus): void {
	const allowed = VALID_PROPOSAL_TRANSITIONS[currentStatus] ?? [];
	if (!allowed.includes(newStatus)) {
		throw new Error(`Cannot transition proposal from "${currentStatus}" to "${newStatus}"`);
	}
}

export function getProposals(): Proposal[] {
	return getDocumentsByType<Proposal>('proposal');
}

export function getProposal(id: string): Proposal | null {
	return getDocument<Proposal>(id, 'proposal');
}

const stmtProposalsByClient = db.prepare(
	"SELECT data FROM documents WHERE type = 'proposal' AND json_extract(data, '$.clientId') = ? ORDER BY created_at DESC"
);

const stmtProposalsByStatus = db.prepare(
	"SELECT data FROM documents WHERE type = 'proposal' AND json_extract(data, '$.status') = ? ORDER BY created_at DESC"
);
const stmtGetProposalData = db.prepare("SELECT data FROM documents WHERE id = ? AND type = 'proposal'");

export function getProposalsByStatus(status: ProposalStatus): Proposal[] {
	const rows = stmtProposalsByStatus.all(status) as { data: string }[];
	return rows.map((r) => JSON.parse(r.data) as Proposal);
}

export function getProposalsByClient(clientId: string): Proposal[] {
	const rows = stmtProposalsByClient.all(clientId) as { data: string }[];
	return rows.map((r) => JSON.parse(r.data) as Proposal);
}

function generateProposalId(settings: ProposalSettings, clientName?: string): string {
	const format = settings.idFormat;
	const now = new Date();
	const counterKey = 'proposal_global';

	// Atomically ensure counter >= nextNumber and increment
	const counter = incrementCounterWithMin(counterKey, settings.nextNumber);
	return resolveIdFormat(format, counter, now, clientName);
}


export const createProposal = db.transaction((
	data: {
		clientId: string;
		pricingMode: 'net' | 'gross';
		currency: string;
		language: string;
		issueDate: string;
		validUntil: string;
		items: Proposal['items'];
		discounts: Proposal['discounts'];
		introText: string;
		notes: string;
		footerText: string;
		templateId: string;
		templateOptions: Record<string, unknown>;
	},
	userId: string
): Proposal => {
	const id = generateId();
	const now = new Date().toISOString();

	const proposalSettings = getSetting<ProposalSettings>('proposals');
	const companySettings = getSetting<CompanySettings>('company');
	const advanced = getSetting<AdvancedSettings>('advanced');
	const client = getDocument<Client>(data.clientId, 'client');

	if (!client) throw new Error('Client not found');
	if (data.templateId && !getTemplate(data.templateId)) throw new Error('Template not found');

	const isKleinunternehmer = advanced?.kleinunternehmer === true;
	const items = isKleinunternehmer ? zeroTaxRates(data.items) : data.items;

	const documentId = generateProposalId(proposalSettings, client.name);
	const totals = computeInvoiceTotals(items, data.discounts, data.pricingMode);

	const proposal: Proposal = {
		id,
		documentId,
		clientId: data.clientId,
		status: 'draft',
		pricingMode: data.pricingMode,
		currency: data.currency,
		language: data.language,
		issueDate: data.issueDate,
		validUntil: data.validUntil,
		items,
		discounts: data.discounts,
		introText: data.introText,
		notes: data.notes,
		footerText: data.footerText,
		templateId: data.templateId,
		templateOptions: data.templateOptions,
		kleinunternehmer: isKleinunternehmer ? true : undefined,
		seller: buildSellerInfo(companySettings),
		buyer: buildBuyerInfo(client),
		totals,
		sentAt: null,
		sentTo: null,
		createdAt: now,
		updatedAt: now
	};

	insertDocument(id, 'proposal', proposal);
	recordChange('proposal', id, 'create', {}, userId);

	return proposal;
});

export function updateProposal(
	id: string,
	data: Partial<Proposal>,
	userId: string
): Proposal | null {
	return db.transaction(() => {
		const existing = getDocument<Proposal>(id, 'proposal');
		if (!existing) return null;

		// Validate status transition if status is changing
		let sentAt: string | undefined;
		if (data.status && data.status !== existing.status) {
			validateProposalStatusTransition(existing.status, data.status);
			if (data.status === 'sent' && !existing.sentAt) {
				sentAt = new Date().toISOString();
			}
		}

		// Block content edits on accepted proposals (contractual snapshot).
		// Check after status transition so status-change attempts get a proper
		// transition error ("cannot transition from accepted to X") instead of
		// the misleading "cannot edit" message.
		if (existing.status === 'accepted') {
			// Strip status and immutable fields to check if any content fields remain
			const { status: _st, seller: _s, buyer: _b, totals: _t, documentId: _d,
				createdAt: _c, id: _id, sentAt: _sa, sentTo: _sto, kleinunternehmer: _ku,
				updatedAt: _ua, ...contentFields } = data;
			const attemptedFields = Object.keys(contentFields);
			if (attemptedFields.length > 0) {
				throw new Error(`Cannot edit accepted proposal: content is locked as a contractual snapshot (attempted: ${attemptedFields.join(', ')})`);
			}
		}

		// Validate date consistency: validUntil must not be before issueDate
		const effectiveIssueDate = data.issueDate ?? existing.issueDate;
		const effectiveValidUntil = data.validUntil ?? existing.validUntil;
		if (effectiveValidUntil < effectiveIssueDate) {
			throw new Error('Cannot set valid-until date before issue date');
		}

		const { totals, resolvedItems } = recomputeTotals(existing, data);

		let buyer = existing.buyer;
		if (data.clientId && data.clientId !== existing.clientId) {
			const client = getDocument<Client>(data.clientId, 'client');
			if (!client) throw new Error('Client not found');
			buyer = buildBuyerInfo(client);
		}

		// Pick only mutable fields from caller data (allowlist approach).
		// Immutable fields (id, documentId, seller, buyer, totals, status, sentAt,
		// sentTo, kleinunternehmer, createdAt) are managed by this function or are
		// creation-time snapshots. Adding a new mutable field requires adding it to
		// PROPOSAL_MUTABLE_FIELDS above.
		const safeData = pickFields(data, PROPOSAL_MUTABLE_FIELDS);

		const updated: Proposal = {
			...existing,
			...safeData,
			id: existing.id,
			documentId: existing.documentId,
			...(resolvedItems ? { items: resolvedItems } : {}),
			// Apply validated status change (if any)
			...(data.status && data.status !== existing.status ? { status: data.status } : {}),
			...(sentAt !== undefined ? { sentAt } : {}),
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
		recordChange('proposal', id, 'update', diff, userId);

		return updated;
	})();
}

export function updateProposalStatus(
	id: string,
	status: Proposal['status'],
	userId: string
): Proposal | null {
	return db.transaction(() => {
		const existing = getDocument<Proposal>(id, 'proposal');
		if (!existing) return null;

		validateProposalStatusTransition(existing.status, status);

		const update: Partial<Proposal> = { status };
		if (status === 'sent' && !existing.sentAt) {
			update.sentAt = new Date().toISOString();
		}
		const updated = { ...existing, ...update, updatedAt: new Date().toISOString() };
		updateDocument(id, updated);
		recordChange('proposal', id, 'status_change', {
			status: { old: existing.status, new: status }
		}, userId);

		return updated;
	})();
}

/**
 * Duplicate a proposal — creates a new draft with a fresh document ID.
 * Wrapped in a transaction so the read + counter increment + insert are atomic.
 */
export const duplicateProposal = db.transaction((id: string, userId: string): Proposal | null => {
	const source = getDocument<Proposal>(id, 'proposal');
	if (!source) return null;

	const today = dayjs();
	const validDays = Math.max(dayjs(source.validUntil).diff(dayjs(source.issueDate), 'day'), 1);

	return createProposal({
		clientId: source.clientId,
		pricingMode: source.pricingMode,
		currency: source.currency,
		language: source.language,
		issueDate: today.format('YYYY-MM-DD'),
		validUntil: today.add(validDays, 'day').format('YYYY-MM-DD'),
		items: structuredClone(source.items),
		discounts: structuredClone(source.discounts),
		introText: source.introText,
		notes: source.notes,
		footerText: source.footerText,
		templateId: source.templateId,
		templateOptions: structuredClone(source.templateOptions)
	}, userId);
});

/**
 * Convert a proposal to a new invoice. Sets proposal status to 'accepted'.
 * Wrapped in a transaction to prevent double-conversion on concurrent requests.
 */
export const convertToInvoice = db.transaction((id: string, userId: string): Invoice => {
	// Re-read inside transaction to guard against concurrent conversion
	const row = stmtGetProposalData.get(id) as { data: string } | undefined;
	if (!row) throw new Error('Proposal not found');
	const source = JSON.parse(row.data) as Proposal;
	// Only 'sent' proposals can be converted
	if (source.status !== 'sent') throw new Error(`Cannot convert proposal with status "${source.status}" — only sent proposals can be converted`);

	const invoiceSettings = getSetting<InvoiceSettings>('invoices');
	const today = dayjs().format('YYYY-MM-DD');
	const dueDate = dayjs().add(invoiceSettings.defaultPaymentTermDays, 'day').format('YYYY-MM-DD');

	// Create invoice first, then mark proposal as accepted.
	// Both are in the same transaction — if either fails, everything rolls back.
	const invoice = createInvoice({
		clientId: source.clientId,
		pricingMode: source.pricingMode,
		currency: source.currency,
		language: source.language,
		issueDate: today,
		dueDate,
		items: structuredClone(source.items),
		discounts: structuredClone(source.discounts),
		notes: source.notes,
		footerText: source.footerText,
		templateId: source.templateId,
		templateOptions: structuredClone(source.templateOptions),
		recurring: null
	}, userId);

	const updated = updateProposalStatus(id, 'accepted', userId);
	if (!updated) throw new Error('Failed to mark proposal as accepted');

	return invoice;
});

export function removeProposal(id: string, userId: string): boolean {
	return db.transaction(() => {
		const existing = getDocument<Proposal>(id, 'proposal');
		if (!existing) return false;

		// Accepted proposals are contractual snapshots — preserve for audit trail
		if (existing.status === 'accepted') {
			throw new Error('Cannot delete an accepted proposal');
		}

		deleteDocument(id);
		recordChange('proposal', id, 'delete', {}, userId);
		return true;
	})();
}
