import {
	generateId,
	getDocument,
	getDocumentsByType,
	insertDocument,
	updateDocument,
	deleteDocument,
	getCounter,
	incrementCounter,
	db
} from '$lib/server/db.js';
import { recordChange, computeDiff } from '$lib/server/changes.js';
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
			throw new Error(`Auto-assigned client number "${peeked}" conflicts with existing record`);
		}
		clientNumber = getNextClientNumber();
	} else {
		clientNumber = data.clientNumber;
		if (stmtClientNumberExists.get(clientNumber, id)) {
			throw new Error(`Client number "${clientNumber}" is already in use`);
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
				throw new Error(`Client number "${data.clientNumber}" is already in use`);
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
			return { ok: false, error: 'Cannot delete client with linked document(s). Delete or reassign them first.' };
		}

		deleteDocument(id);
		recordChange('client', id, 'delete', {}, userId);

		return { ok: true };
	})();
}
