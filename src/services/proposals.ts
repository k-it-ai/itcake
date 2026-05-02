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
import { createInvoice } from '$services/invoices.js';
import { getTemplate } from '$services/templates.js';
import { buildSellerInfo, buildBuyerInfo, zeroTaxRates, recomputeTotals, pickFields, validateTransition } from '$services/document-helpers.js';
import dayjs from 'dayjs';
import { ServiceError } from '$lib/server/service-error.js';
import type { Proposal, ProposalStatus, ProposalSettings, InvoiceSettings, CompanySettings, Client, Invoice, AdvancedSettings } from '$lib/types.js';

export const PROPOSAL_STATUSES: readonly ProposalStatus[] = ['draft', 'sent', 'accepted', 'rejected', 'expired'];

const PROPOSAL_MUTABLE_FIELDS = new Set<keyof Proposal>([
	'clientId', 'pricingMode', 'currency', 'language',
	'issueDate', 'validUntil', 'items', 'discounts',
	'introText', 'notes', 'footerText', 'templateId', 'templateOptions',
	'sentTo'
]);

export const VALID_PROPOSAL_TRANSITIONS: Record<ProposalStatus, ProposalStatus[]> = {
	draft: ['sent'],
	sent: ['accepted', 'rejected', 'expired'],
	accepted: [],
	rejected: ['draft'],
	expired: ['draft']
};

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

export function getProposalsByStatus(status: ProposalStatus): Proposal[] {
	const rows = stmtProposalsByStatus.all(status) as { data: string }[];
	return rows.map((r) => JSON.parse(r.data) as Proposal);
}

export function getProposalsByClient(clientId: string): Proposal[] {
	const rows = stmtProposalsByClient.all(clientId) as { data: string }[];
	return rows.map((r) => JSON.parse(r.data) as Proposal);
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

	const documentId = generateNumberedId('proposal_global', proposalSettings, client.name);
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
		kleinunternehmer: isKleinunternehmer,
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

		if (data.status && data.status !== existing.status) {
			throw new ServiceError('error.statusViaDedicatedEndpoint');
		}

		if (existing.status === 'accepted') {
			const { status: _st, seller: _s, buyer: _b, totals: _t, documentId: _d,
				createdAt: _c, id: _id, sentAt: _sa, sentTo: _sto, kleinunternehmer: _ku,
				updatedAt: _ua, ...contentFields } = data;
			const attemptedFields = Object.keys(contentFields);
			if (attemptedFields.length > 0) {
				throw new ServiceError('error.cannotEditAcceptedProposal');
			}
		}

		const effectiveIssueDate = data.issueDate ?? existing.issueDate;
		const effectiveValidUntil = data.validUntil ?? existing.validUntil;
		if (effectiveValidUntil < effectiveIssueDate) {
			throw new ServiceError('error.validUntilBeforeIssueDate');
		}

		const { totals, resolvedItems } = recomputeTotals(existing, data);

		let buyer = existing.buyer;
		if (data.clientId && data.clientId !== existing.clientId) {
			const client = getDocument<Client>(data.clientId, 'client');
			if (!client) throw new Error('Client not found');
			buyer = buildBuyerInfo(client);
		}

		const safeData = pickFields(data, PROPOSAL_MUTABLE_FIELDS);

		const updated: Proposal = {
			...existing,
			...safeData,
			id: existing.id,
			documentId: existing.documentId,
			...(resolvedItems ? { items: resolvedItems } : {}),
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

		validateTransition(VALID_PROPOSAL_TRANSITIONS, existing.status, status);

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

export const convertToInvoice = db.transaction((id: string, userId: string): Invoice => {
	const source = getDocument<Proposal>(id, 'proposal');
	if (!source) throw new Error('Proposal not found');
	if (source.status !== 'sent') throw new ServiceError('error.cannotConvertProposalStatus', { status: source.status });

	const invoiceSettings = getSetting<InvoiceSettings>('invoices');
	const today = dayjs().format('YYYY-MM-DD');
	const dueDate = dayjs().add(invoiceSettings.defaultPaymentTermDays, 'day').format('YYYY-MM-DD');

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

		if (existing.status === 'accepted') {
			throw new ServiceError('error.cannotDeleteAcceptedProposal');
		}

		deleteDocument(id);
		recordChange('proposal', id, 'delete', {}, userId);
		return true;
	})();
}

interface ProposalFilters {
	status?: string;
	clientName?: string;
	search?: string;
	dateFrom?: string;
	dateTo?: string;
}

export function getProposalsPaginated(filters: ProposalFilters = {}, page = 1, pageSize = 25): PaginatedResult<Proposal> {
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

	return queryDocumentsPaginated<Proposal>('proposal', { filters: queryFilters, page, pageSize });
}

const stmtDistinctProposalClientNames = db.prepare(
	"SELECT DISTINCT json_extract(data, '$.buyer.name') as name FROM documents WHERE type = 'proposal' AND json_extract(data, '$.buyer.name') IS NOT NULL ORDER BY name"
);

export function getDistinctProposalClientNames(): string[] {
	return (stmtDistinctProposalClientNames.all() as { name: string }[]).map(r => r.name).filter(Boolean);
}
