import { json, error } from '@sveltejs/kit';
import type { RequestHandler } from './$types.js';
import { db } from '$lib/server/db.js';

interface SearchResult {
	type: 'invoice' | 'proposal' | 'client' | 'expense' | 'ticket' | 'monitor' | 'catalog_item';
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
		json_extract(data, '$.documentId') LIKE @p ESCAPE '\\' OR
		json_extract(data, '$.buyer.name') LIKE @p ESCAPE '\\' OR
		json_extract(data, '$.seller.name') LIKE @p ESCAPE '\\' OR
		json_extract(data, '$.notes') LIKE @p ESCAPE '\\' OR
		json_extract(data, '$.status') LIKE @p ESCAPE '\\' OR
		json_extract(data, '$.currency') LIKE @p ESCAPE '\\'
	)
	ORDER BY created_at DESC
	LIMIT 10
`);

const searchProposalsStmt = db.prepare(`
	SELECT id, data FROM documents
	WHERE type = 'proposal' AND (
		json_extract(data, '$.documentId') LIKE @p ESCAPE '\\' OR
		json_extract(data, '$.buyer.name') LIKE @p ESCAPE '\\' OR
		json_extract(data, '$.seller.name') LIKE @p ESCAPE '\\' OR
		json_extract(data, '$.notes') LIKE @p ESCAPE '\\' OR
		json_extract(data, '$.status') LIKE @p ESCAPE '\\' OR
		json_extract(data, '$.currency') LIKE @p ESCAPE '\\'
	)
	ORDER BY created_at DESC
	LIMIT 10
`);

const searchExpensesStmt = db.prepare(`
	SELECT id, data FROM documents
	WHERE type = 'expense' AND (
		json_extract(data, '$.description') LIKE @p ESCAPE '\\' OR
		json_extract(data, '$.vendor') LIKE @p ESCAPE '\\' OR
		json_extract(data, '$.category') LIKE @p ESCAPE '\\' OR
		json_extract(data, '$.notes') LIKE @p ESCAPE '\\'
	)
	ORDER BY created_at DESC
	LIMIT 10
`);

const searchTicketsStmt = db.prepare(`
	SELECT id, data FROM documents
	WHERE type = 'ticket' AND (
		json_extract(data, '$.ticketNumber') LIKE @p ESCAPE '\\' OR
		json_extract(data, '$.title') LIKE @p ESCAPE '\\' OR
		json_extract(data, '$.notes') LIKE @p ESCAPE '\\' OR
		json_extract(data, '$.status') LIKE @p ESCAPE '\\'
	)
	ORDER BY created_at DESC
	LIMIT 10
`);

const searchMonitorsStmt = db.prepare(`
	SELECT id, data FROM monitors
	WHERE json_extract(data, '$.name') LIKE @p ESCAPE '\\'
	   OR json_extract(data, '$.ip') LIKE @p ESCAPE '\\'
	   OR json_extract(data, '$.domain') LIKE @p ESCAPE '\\'
	ORDER BY created_at DESC
	LIMIT 10
`);

const searchCatalogItemsStmt = db.prepare(`
	SELECT id, data FROM documents
	WHERE type = 'catalog_item' AND (
		json_extract(data, '$.name') LIKE @p ESCAPE '\\' OR
		json_extract(data, '$.description') LIKE @p ESCAPE '\\'
	)
	ORDER BY created_at DESC
	LIMIT 10
`);

const searchClientsStmt = db.prepare(`
	SELECT id, data FROM documents
	WHERE type = 'client' AND (
		json_extract(data, '$.name') LIKE @p ESCAPE '\\' OR
		json_extract(data, '$.clientNumber') LIKE @p ESCAPE '\\' OR
		json_extract(data, '$.email') LIKE @p ESCAPE '\\' OR
		json_extract(data, '$.contactPerson') LIKE @p ESCAPE '\\' OR
		json_extract(data, '$.vatNumber') LIKE @p ESCAPE '\\' OR
		json_extract(data, '$.notes') LIKE @p ESCAPE '\\'
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
	const invoiceRows = searchInvoicesStmt.all({ p: pattern }) as { id: string; data: string }[];
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
	const proposalRows = searchProposalsStmt.all({ p: pattern }) as { id: string; data: string }[];
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
	const clientRows = searchClientsStmt.all({ p: pattern }) as { id: string; data: string }[];
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
	const expenseRows = searchExpensesStmt.all({ p: pattern }) as { id: string; data: string }[];
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

	// Search tickets
	const ticketRows = searchTicketsStmt.all({ p: pattern }) as { id: string; data: string }[];
	for (const row of ticketRows) {
		try {
			const ticket = JSON.parse(row.data);
			results.push({
				type: 'ticket',
				id: row.id,
				title: ticket.title ? `${ticket.ticketNumber} · ${ticket.title}` : ticket.ticketNumber,
				subtitle: `${ticket.date} — ${ticket.status}`,
				href: `/tickets`
			});
		} catch (e) { console.warn(`Corrupted ticket row ${row.id}:`, e instanceof Error ? e.message : e); }
	}

	// Search monitors (separate table)
	const monitorRows = searchMonitorsStmt.all({ p: pattern }) as { id: string; data: string }[];
	for (const row of monitorRows) {
		try {
			const mon = JSON.parse(row.data);
			results.push({
				type: 'monitor',
				id: row.id,
				title: mon.name,
				subtitle: [mon.ip, mon.domain].filter(Boolean).join(' / '),
				href: `/uptime`
			});
		} catch (e) { console.warn(`Corrupted monitor row ${row.id}:`, e instanceof Error ? e.message : e); }
	}

	// Search catalog items
	const catalogRows = searchCatalogItemsStmt.all({ p: pattern }) as { id: string; data: string }[];
	for (const row of catalogRows) {
		try {
			const item = JSON.parse(row.data);
			results.push({
				type: 'catalog_item',
				id: row.id,
				title: item.name,
				subtitle: item.description || '',
				href: `/catalog`
			});
		} catch (e) { console.warn(`Corrupted catalog item row ${row.id}:`, e instanceof Error ? e.message : e); }
	}

	return json(results.slice(0, 20));
};
