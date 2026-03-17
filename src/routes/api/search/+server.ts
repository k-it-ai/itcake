import { json, error } from '@sveltejs/kit';
import type { RequestHandler } from './$types.js';
import { db } from '$lib/server/db.js';

interface SearchResult {
	type: 'invoice' | 'proposal' | 'client' | 'expense';
	id: string;
	title: string;
	subtitle: string;
	href: string;
}

/**
 * SQL-level search using json_extract + LIKE — avoids loading all documents into memory.
 */
const searchInvoicesStmt = db.prepare(`
	SELECT id, data FROM documents
	WHERE type = 'invoice' AND (
		json_extract(data, '$.documentId') LIKE ?1 ESCAPE '\\' OR
		json_extract(data, '$.buyer.name') LIKE ?1 ESCAPE '\\' OR
		json_extract(data, '$.seller.name') LIKE ?1 ESCAPE '\\' OR
		json_extract(data, '$.notes') LIKE ?1 ESCAPE '\\' OR
		json_extract(data, '$.status') LIKE ?1 ESCAPE '\\' OR
		json_extract(data, '$.currency') LIKE ?1 ESCAPE '\\'
	)
	ORDER BY created_at DESC
	LIMIT 10
`);

const searchProposalsStmt = db.prepare(`
	SELECT id, data FROM documents
	WHERE type = 'proposal' AND (
		json_extract(data, '$.documentId') LIKE ?1 ESCAPE '\\' OR
		json_extract(data, '$.buyer.name') LIKE ?1 ESCAPE '\\' OR
		json_extract(data, '$.seller.name') LIKE ?1 ESCAPE '\\' OR
		json_extract(data, '$.notes') LIKE ?1 ESCAPE '\\' OR
		json_extract(data, '$.status') LIKE ?1 ESCAPE '\\' OR
		json_extract(data, '$.currency') LIKE ?1 ESCAPE '\\'
	)
	ORDER BY created_at DESC
	LIMIT 10
`);

const searchExpensesStmt = db.prepare(`
	SELECT id, data FROM documents
	WHERE type = 'expense' AND (
		json_extract(data, '$.description') LIKE ?1 ESCAPE '\\' OR
		json_extract(data, '$.vendor') LIKE ?1 ESCAPE '\\' OR
		json_extract(data, '$.category') LIKE ?1 ESCAPE '\\' OR
		json_extract(data, '$.notes') LIKE ?1 ESCAPE '\\'
	)
	ORDER BY created_at DESC
	LIMIT 10
`);

const searchClientsStmt = db.prepare(`
	SELECT id, data FROM documents
	WHERE type = 'client' AND (
		json_extract(data, '$.name') LIKE ?1 ESCAPE '\\' OR
		json_extract(data, '$.clientNumber') LIKE ?1 ESCAPE '\\' OR
		json_extract(data, '$.email') LIKE ?1 ESCAPE '\\' OR
		json_extract(data, '$.contactPerson') LIKE ?1 ESCAPE '\\' OR
		json_extract(data, '$.vatNumber') LIKE ?1 ESCAPE '\\' OR
		json_extract(data, '$.notes') LIKE ?1 ESCAPE '\\'
	)
	ORDER BY created_at DESC
	LIMIT 10
`);

export const GET: RequestHandler = async ({ url, locals }) => {
	if (!locals.user) throw error(401);

	const q = (url.searchParams.get('q') ?? '').trim().toLowerCase().slice(0, 200);
	if (q.length < 2) return json([]);

	// Escape LIKE wildcards to prevent information disclosure via wildcard injection
	const escaped = q.replace(/\\/g, '\\\\').replace(/%/g, '\\%').replace(/_/g, '\\_');
	const pattern = `%${escaped}%`;
	const results: SearchResult[] = [];

	// Search invoices
	const invoiceRows = searchInvoicesStmt.all(pattern) as { id: string; data: string }[];
	for (const row of invoiceRows) {
		try {
			const inv = JSON.parse(row.data);
			results.push({
				type: 'invoice',
				id: row.id,
				title: inv.documentId,
				subtitle: `${inv.buyer?.name ?? ''} — ${inv.status}`,
				href: `/invoices/${row.id}`
			});
		} catch (e) { console.warn(`Corrupted invoice row ${row.id}:`, e instanceof Error ? e.message : e); }
	}

	// Search proposals
	const proposalRows = searchProposalsStmt.all(pattern) as { id: string; data: string }[];
	for (const row of proposalRows) {
		try {
			const prop = JSON.parse(row.data);
			results.push({
				type: 'proposal',
				id: row.id,
				title: prop.documentId,
				subtitle: `${prop.buyer?.name ?? ''} — ${prop.status}`,
				href: `/proposals/${row.id}`
			});
		} catch (e) { console.warn(`Corrupted proposal row ${row.id}:`, e instanceof Error ? e.message : e); }
	}

	// Search clients
	const clientRows = searchClientsStmt.all(pattern) as { id: string; data: string }[];
	for (const row of clientRows) {
		try {
			const client = JSON.parse(row.data);
			results.push({
				type: 'client',
				id: row.id,
				title: client.name,
				subtitle: client.clientNumber || client.email || '',
				href: `/clients/${row.id}`
			});
		} catch (e) { console.warn(`Corrupted client row ${row.id}:`, e instanceof Error ? e.message : e); }
	}

	// Search expenses
	const expenseRows = searchExpensesStmt.all(pattern) as { id: string; data: string }[];
	for (const row of expenseRows) {
		try {
			const exp = JSON.parse(row.data);
			results.push({
				type: 'expense',
				id: row.id,
				title: exp.description,
				subtitle: `${exp.vendor || exp.category || 'Uncategorized'} — ${exp.date}`,
				href: `/expenses`
			});
		} catch (e) { console.warn(`Corrupted expense row ${row.id}:`, e instanceof Error ? e.message : e); }
	}

	return json(results.slice(0, 20));
};
