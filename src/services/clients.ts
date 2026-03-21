import {
	generateId,
	getDocument,
	getDocumentsByType,
	insertDocument,
	updateDocument,
	deleteDocument,
	getCounter,
	incrementCounter,
	db,
	queryDocumentsPaginated
} from '$lib/server/db.js';
import type { PaginatedResult } from '$lib/server/db.js';
import { recordChange, computeDiff } from '$lib/server/changes.js';
import { ServiceError } from '$lib/server/service-error.js';
import type { Client } from '$lib/types.js';

const stmtHasLinkedDocs = db.prepare(
	"SELECT 1 FROM documents WHERE type IN ('invoice', 'proposal', 'ticket') AND json_extract(data, '$.clientId') = ? LIMIT 1"
);

const stmtClientNumberExists = db.prepare(
	"SELECT 1 FROM documents WHERE type = 'client' AND json_extract(data, '$.clientNumber') = ? AND id != ? LIMIT 1"
);

export function getClients(): Client[] {
	return getDocumentsByType<Client>('client');
}

const stmtClientIdNames = db.prepare(
	"SELECT id, json_extract(data, '$.name') as name FROM documents WHERE type = 'client' ORDER BY json_extract(data, '$.name') ASC"
);

/** Lightweight: returns only id + name for dropdowns. Avoids loading full JSON blobs. */
export function getClientIdNames(): { id: string; name: string }[] {
	return stmtClientIdNames.all() as { id: string; name: string }[];
}

const stmtClientDropdown = db.prepare(
	"SELECT id, json_extract(data, '$.name') as name, json_extract(data, '$.currency') as currency, json_extract(data, '$.language') as language FROM documents WHERE type = 'client' ORDER BY json_extract(data, '$.name') ASC"
);

/** Returns id, name, currency, language for new invoice/proposal pages (auto-fill from client). */
export function getClientDropdownData(): { id: string; name: string; currency: string; language: string }[] {
	return stmtClientDropdown.all() as { id: string; name: string; currency: string; language: string }[];
}

export function getClient(id: string): Client | null {
	return getDocument<Client>(id, 'client');
}

/**
 * Preview the next client number without incrementing the counter.
 */
export function peekNextClientNumber(): string {
	const counter = getCounter('client_global') + 1;
	return `C-${String(counter).padStart(3, '0')}`;
}

/**
 * Generate the next auto-assigned client number (e.g. "C-001").
 */
export function getNextClientNumber(): string {
	const counter = incrementCounter('client_global');
	return `C-${String(counter).padStart(3, '0')}`;
}

export const createClient = db.transaction((data: Omit<Client, 'id' | 'createdAt' | 'updatedAt'>, userId: string): Client => {
	const id = generateId();
	const now = new Date().toISOString();

	// Auto-assign client number if not provided or if it matches the next
	// auto-assigned value. The new-client form pre-fills with the peeked value,
	// so treat that as auto-assign to keep the counter in sync.
	let clientNumber: string;
	const peeked = peekNextClientNumber();
	if (!data.clientNumber || data.clientNumber === peeked) {
		if (stmtClientNumberExists.get(peeked, id)) {
			throw new ServiceError('error.clientNumberInUse', { number: peeked });
		}
		clientNumber = getNextClientNumber();
	} else {
		clientNumber = data.clientNumber;
		if (stmtClientNumberExists.get(clientNumber, id)) {
			throw new ServiceError('error.clientNumberInUse', { number: clientNumber });
		}
	}

	const client: Client = {
		id,
		...data,
		clientNumber,
		createdAt: now,
		updatedAt: now
	};

	insertDocument(id, 'client', client);
	recordChange('client', id, 'create', {}, userId);

	return client;
});

export function updateClient(
	id: string,
	data: Partial<Client>,
	userId: string
): Client | null {
	return db.transaction(() => {
		const existing = getDocument<Client>(id, 'client');
		if (!existing) return null;

		// Prevent duplicate client numbers on update
		if (data.clientNumber && data.clientNumber !== existing.clientNumber) {
			if (stmtClientNumberExists.get(data.clientNumber, id)) {
				throw new ServiceError('error.clientNumberInUse', { number: data.clientNumber });
			}
		}

		const updated: Client = {
			...existing,
			...data,
			id, // preserve id
			createdAt: existing.createdAt,
			updatedAt: new Date().toISOString()
		};

		const diff = computeDiff(
			existing as unknown as Record<string, unknown>,
			updated as unknown as Record<string, unknown>
		);

		updateDocument(id, updated);
		recordChange('client', id, 'update', diff, userId);

		return updated;
	})();
}

export function removeClient(id: string, userId: string): { ok: boolean; error?: string } {
	return db.transaction(() => {
		const existing = getDocument<Client>(id, 'client');
		if (!existing) return { ok: false, error: 'Client not found' };

		// Block deletion if linked invoices or proposals exist (SQL-level check, avoids full scan)
		const hasLinkedDocs = stmtHasLinkedDocs.get(id);
		if (hasLinkedDocs) {
			throw new ServiceError('error.cannotDeleteClientWithLinkedDocs');
		}

		deleteDocument(id);
		recordChange('client', id, 'delete', {}, userId);

		return { ok: true };
	})();
}

// ── Server-side pagination ──────────────────────────────────────────

export interface ClientFilters {
	search?: string;
}

export function getClientsPaginated(filters: ClientFilters = {}, page = 1, pageSize = 25): PaginatedResult<Client> {
	const queryFilters: Array<{ sql: string; params: unknown[] }> = [];

	if (filters.search) {
		const escaped = filters.search.replace(/\\/g, '\\\\').replace(/%/g, '\\%').replace(/_/g, '\\_');
		const q = `%${escaped}%`;
		queryFilters.push({
			sql: "(json_extract(data, '$.name') LIKE ? ESCAPE '\\' OR json_extract(data, '$.email') LIKE ? ESCAPE '\\')",
			params: [q, q]
		});
	}

	return queryDocumentsPaginated<Client>('client', { filters: queryFilters, page, pageSize });
}

const stmtClientRevenue = db.prepare(`
	SELECT
		json_extract(data, '$.clientId') as clientId,
		SUM(CASE WHEN json_extract(data, '$.status') = 'paid' THEN json_extract(data, '$.totals.total') ELSE 0 END) as paid,
		SUM(CASE WHEN json_extract(data, '$.status') IN ('sent', 'overdue') THEN json_extract(data, '$.totals.total') ELSE 0 END) as outstanding
	FROM documents
	WHERE type = 'invoice'
		AND json_extract(data, '$.invoiceType') != 'creditNote'
		AND json_extract(data, '$.clientId') IS NOT NULL
	GROUP BY json_extract(data, '$.clientId')
`);

export function getClientRevenueMap(): Record<string, { paid: number; outstanding: number }> {
	const rows = stmtClientRevenue.all() as { clientId: string; paid: number; outstanding: number }[];
	const map: Record<string, { paid: number; outstanding: number }> = {};
	for (const r of rows) {
		map[r.clientId] = { paid: r.paid || 0, outstanding: r.outstanding || 0 };
	}
	return map;
}
