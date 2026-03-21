import {
	db,
	generateId,
	getDocument,
	getDocumentsByType,
	insertDocument,
	updateDocument,
	deleteDocument,
	getSetting,
	incrementCounterWithMin,
	incrementCounter,
	queryDocumentsPaginated
} from '$lib/server/db.js';
import type { PaginatedResult } from '$lib/server/db.js';
import { recordChange, computeDiff } from '$lib/server/changes.js';
import { buildSellerInfo, buildBuyerInfo, validateTransition } from '$services/document-helpers.js';
import { computeInvoiceTotals } from '$lib/money.js';
import { resolveIdFormat } from '$lib/id-format.js';
import { sanitizeRichText } from '$lib/server/sanitize.js';
import { serverT } from '$lib/i18n/server.js';
import { ServiceError } from '$lib/server/service-error.js';
import type { Ticket, TicketStatus, Client, Invoice, InvoiceSettings, CompanySettings, AdvancedSettings, GeneralSettings } from '$lib/types.js';
import type { z } from 'zod';
import type { ticketSchema } from '$lib/validators.js';
import dayjs from 'dayjs';

type TicketInput = z.infer<typeof ticketSchema>;

export const VALID_TRANSITIONS: Record<TicketStatus, TicketStatus[]> = {
	open: ['completed'],
	completed: ['open'],
	invoiced: [],
};

// Cached prepared statements
const stmtTicketsByStatus = db.prepare(
	"SELECT data FROM documents WHERE type = 'ticket' AND json_extract(data, '$.status') = ? ORDER BY json_extract(data, '$.date') DESC"
);
const stmtTicketsByDateRange = db.prepare(
	"SELECT data FROM documents WHERE type = 'ticket' AND json_extract(data, '$.date') >= ? AND json_extract(data, '$.date') <= ? ORDER BY json_extract(data, '$.date') ASC, json_extract(data, '$.startTime') ASC"
);
const stmtTicketsByClient = db.prepare(
	"SELECT data FROM documents WHERE type = 'ticket' AND json_extract(data, '$.clientId') = ? ORDER BY json_extract(data, '$.date') DESC"
);

function generateTicketNumber(): string {
	const counter = incrementCounter('ticket_global');
	return `T-${String(counter).padStart(3, '0')}`;
}

export function getTickets(): Ticket[] {
	return getDocumentsByType<Ticket>('ticket');
}

export interface TicketFilters {
	status?: string;
	clientId?: string;
	search?: string;
	dateFrom?: string;
	dateTo?: string;
}

export function getTicketsPaginated(filters: TicketFilters = {}, page = 1, pageSize = 25): PaginatedResult<Ticket> {
	const queryFilters: Array<{ sql: string; params: unknown[] }> = [];

	if (filters.status) {
		queryFilters.push({ sql: "json_extract(data, '$.status') = ?", params: [filters.status] });
	}
	if (filters.clientId) {
		queryFilters.push({ sql: "json_extract(data, '$.clientId') = ?", params: [filters.clientId] });
	}
	if (filters.search) {
		const escaped = filters.search.replace(/\\/g, '\\\\').replace(/%/g, '\\%').replace(/_/g, '\\_');
		const q = `%${escaped}%`;
		queryFilters.push({
			sql: "(json_extract(data, '$.ticketNumber') LIKE ? ESCAPE '\\' OR json_extract(data, '$.title') LIKE ? ESCAPE '\\')",
			params: [q, q]
		});
	}
	if (filters.dateFrom) {
		queryFilters.push({ sql: "json_extract(data, '$.date') >= ?", params: [filters.dateFrom] });
	}
	if (filters.dateTo) {
		queryFilters.push({ sql: "json_extract(data, '$.date') <= ?", params: [filters.dateTo] });
	}

	return queryDocumentsPaginated<Ticket>('ticket', { filters: queryFilters, page, pageSize });
}

export function getTicket(id: string): Ticket | null {
	return getDocument<Ticket>(id, 'ticket');
}

export function getTicketsByStatus(status: TicketStatus): Ticket[] {
	const rows = stmtTicketsByStatus.all(status) as { data: string }[];
	return rows.map(r => JSON.parse(r.data) as Ticket);
}

export function getTicketsByDateRange(from: string, to: string): Ticket[] {
	const rows = stmtTicketsByDateRange.all(from, to) as { data: string }[];
	return rows.map(r => JSON.parse(r.data) as Ticket);
}

const stmtTicketStats = db.prepare(`
	SELECT
		SUM(CASE WHEN json_extract(data, '$.date') >= ? AND json_extract(data, '$.date') <= ? THEN json_extract(data, '$.hours') ELSE 0 END) as hoursWeek,
		SUM(CASE WHEN json_extract(data, '$.date') >= ? AND json_extract(data, '$.date') <= ? THEN json_extract(data, '$.hours') ELSE 0 END) as hoursMonth,
		SUM(CASE WHEN json_extract(data, '$.date') >= ? AND json_extract(data, '$.date') <= ? THEN ROUND(json_extract(data, '$.hours') * json_extract(data, '$.hourlyRate')) ELSE 0 END) as earningsWeek,
		SUM(CASE WHEN json_extract(data, '$.date') >= ? AND json_extract(data, '$.date') <= ? THEN ROUND(json_extract(data, '$.hours') * json_extract(data, '$.hourlyRate')) ELSE 0 END) as earningsMonth
	FROM documents WHERE type = 'ticket'
`);

export function getTicketStats(weekStart: string, monthStart: string, today: string): {
	hoursWeek: number; hoursMonth: number; earningsWeek: number; earningsMonth: number;
} {
	const row = stmtTicketStats.get(weekStart, today, monthStart, today, weekStart, today, monthStart, today) as {
		hoursWeek: number | null; hoursMonth: number | null; earningsWeek: number | null; earningsMonth: number | null;
	};
	return {
		hoursWeek: row.hoursWeek ?? 0,
		hoursMonth: row.hoursMonth ?? 0,
		earningsWeek: Math.round(row.earningsWeek ?? 0),
		earningsMonth: Math.round(row.earningsMonth ?? 0)
	};
}

export function getTicketsByClient(clientId: string): Ticket[] {
	const rows = stmtTicketsByClient.all(clientId) as { data: string }[];
	return rows.map(r => JSON.parse(r.data) as Ticket);
}

export const createTicket = db.transaction((data: TicketInput, userId: string): Ticket => {
	// Verify client exists before generating ID (matches invoices.ts pattern)
	const client = getDocument<Client>(data.clientId, 'client');
	if (!client) throw new Error('Client not found');

	const id = generateId();
	const ticketNumber = generateTicketNumber();
	const now = new Date().toISOString();

	// Sanitize rich HTML description server-side
	const description = data.description ? sanitizeRichText(data.description) : '';

	const ticket: Ticket = {
		id,
		ticketNumber,
		title: data.title || '',
		description,
		clientId: data.clientId,
		date: data.date,
		startTime: data.startTime,
		hours: data.hours,
		hourlyRate: data.hourlyRate,
		status: 'open',
		invoiceId: null,
		notes: data.notes,
		createdAt: now,
		updatedAt: now
	};

	insertDocument(id, 'ticket', ticket);
	recordChange('ticket', id, 'create', {}, userId);
	return ticket;
});

export function updateTicket(id: string, data: Partial<TicketInput>, userId: string): Ticket | null {
	return db.transaction(() => {
		const existing = getTicket(id);
		if (!existing) return null;
		if (existing.status === 'invoiced') throw new ServiceError('error.cannotEditInvoicedTicket');

		// Verify client if changing
		if (data.clientId && data.clientId !== existing.clientId) {
			const client = getDocument<Client>(data.clientId, 'client');
			if (!client) throw new Error('Client not found');
		}

		// Sanitize rich HTML description server-side
		if (data.description !== undefined) {
			data = { ...data, description: data.description ? sanitizeRichText(data.description) : '' };
		}

		const updated: Ticket = {
			...existing,
			...data,
			id: existing.id,
			ticketNumber: existing.ticketNumber,
			status: existing.status,
			invoiceId: existing.invoiceId,
			createdAt: existing.createdAt,
			updatedAt: new Date().toISOString()
		};

		const diff = computeDiff(
			existing as unknown as Record<string, unknown>,
			updated as unknown as Record<string, unknown>
		);
		updateDocument(id, updated);
		recordChange('ticket', id, 'update', diff, userId);
		return updated;
	})();
}

export function updateTicketStatus(id: string, status: TicketStatus, userId: string): Ticket | null {
	return db.transaction(() => {
		const existing = getTicket(id);
		if (!existing) return null;

		validateTransition(VALID_TRANSITIONS, existing.status, status);

		const updated: Ticket = {
			...existing,
			status,
			updatedAt: new Date().toISOString()
		};
		updateDocument(id, updated);
		recordChange('ticket', id, 'status_change', {
			status: { old: existing.status, new: status }
		}, userId);
		return updated;
	})();
}

export function removeTicket(id: string, userId: string): boolean {
	return db.transaction(() => {
		const existing = getTicket(id);
		if (!existing) return false;
		if (existing.status === 'invoiced') throw new ServiceError('error.cannotDeleteInvoicedTicket');
		deleteDocument(id);
		recordChange('ticket', id, 'delete', {}, userId);
		return true;
	})();
}

interface ConvertOptions {
	mode: 'new' | 'existing';
	invoiceId?: string;
}

export function convertTicketToInvoice(
	ticketId: string,
	options: ConvertOptions,
	userId: string
): Invoice {
	return db.transaction(() => {
		const ticket = getTicket(ticketId);
		if (!ticket) throw new Error('Ticket not found');
		if (ticket.status === 'invoiced') throw new ServiceError('error.ticketAlreadyInvoiced');

		const client = getDocument<Client>(ticket.clientId, 'client');
		if (!client) throw new Error('Client not found');

		const invoiceSettings = getSetting<InvoiceSettings>('invoices');
		const companySettings = getSetting<CompanySettings>('company');
		const generalSettings = getSetting<GeneralSettings>('general');
		const advanced = getSetting<AdvancedSettings>('advanced');
		const isKleinunternehmer = advanced?.kleinunternehmer === true;

		// Line item title: use ticket title if set, otherwise default localized format
		const lang = generalSettings.language || 'en';
		const st = serverT(lang);
		const dateFormat = lang === 'de' ? 'DD.MM.YYYY' : generalSettings.dateFormat || 'YYYY-MM-DD';
		const defaultName = st('ticket.defaultLineItemFull', { date: dayjs(ticket.date).format(dateFormat) });
		const itemName = ticket.title || defaultName;
		const unitLabel = st('ticket.unitHours');

		const taxRate = isKleinunternehmer ? 0 : invoiceSettings.defaultTaxRate;

		const lineItem = {
			id: generateId(),
			name: itemName,
			description: ticket.description,
			quantity: Math.round(ticket.hours * 100) / 100,
			unit: unitLabel,
			unitPrice: ticket.hourlyRate,
			taxRate,
			items: [] as Invoice['items']
		};

		let invoice: Invoice;

		if (options.mode === 'existing') {
			// Append to existing invoice (draft or sent when not edit-locked)
			if (!options.invoiceId) throw new Error('Invoice ID required for existing mode');
			const existing = getDocument<Invoice>(options.invoiceId, 'invoice');
			if (!existing) throw new Error('Invoice not found');

			// Allow draft always; allow sent only when editLock is not 'sent'
			const editLock = advanced?.editLock ?? 'none';
			const allowedStatuses = editLock === 'sent' ? ['draft'] : ['draft', 'sent'];
			if (!allowedStatuses.includes(existing.status)) {
				throw new ServiceError('error.invoiceLockedFromEditing');
			}
			if (existing.clientId !== ticket.clientId) throw new ServiceError('error.invoiceClientMismatch');

			const updatedItems = [...existing.items, lineItem];
			const totals = computeInvoiceTotals(updatedItems, existing.discounts, existing.pricingMode);
			const updated: Invoice = {
				...existing,
				items: updatedItems,
				totals,
				updatedAt: new Date().toISOString()
			};
			updateDocument(existing.id, updated);
			recordChange('invoice', existing.id, 'update', {
				items: { old: '[changed]', new: '[changed]' },
				totals: { old: '[changed]', new: '[changed]' }
			}, userId);
			invoice = updated;
		} else {
			// Create new invoice
			const id = generateId();
			const now = new Date().toISOString();
			const today = dayjs();
			const paymentTermDays = invoiceSettings.defaultPaymentTermDays ?? 30;

			const format = invoiceSettings.idFormat;
			const counter = incrementCounterWithMin('invoice_global', invoiceSettings.nextNumber);
			const documentId = resolveIdFormat(format, counter, new Date(), client.name);

			const items = [lineItem];
			const totals = computeInvoiceTotals(items, [], invoiceSettings.defaultPricingMode as 'net' | 'gross');

			invoice = {
				id,
				documentId,
				invoiceType: 'invoice',
				linkedInvoiceId: null,
				clientId: ticket.clientId,
				status: 'draft',
				pricingMode: invoiceSettings.defaultPricingMode as 'net' | 'gross',
				currency: client.currency || generalSettings.currency || 'EUR',
				language: client.language || generalSettings.language || 'en',
				issueDate: today.format('YYYY-MM-DD'),
				dueDate: today.add(paymentTermDays, 'day').format('YYYY-MM-DD'),
				paidDate: null,
				items,
				discounts: [],
				notes: invoiceSettings.defaultNotes || '',
				footerText: invoiceSettings.defaultFooter || '',
				templateId: invoiceSettings.defaultTemplate || 'plain',
				templateOptions: {},
				recurring: null,
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
			recordChange('invoice', id, 'create', {}, userId);
		}

		// Mark ticket as invoiced
		const updatedTicket: Ticket = {
			...ticket,
			status: 'invoiced',
			invoiceId: invoice.id,
			updatedAt: new Date().toISOString()
		};
		updateDocument(ticketId, updatedTicket);
		recordChange('ticket', ticketId, 'status_change', {
			status: { old: ticket.status, new: 'invoiced' }
		}, userId);

		return invoice;
	})();
}
