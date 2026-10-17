import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types.js';
import { db, getSetting, escapeSqlLike } from '#lib/server/db.js';
import { serverT } from '#lib/i18n/server.js';
import type { GeneralSettings } from '#lib/types.js';
import { requireUser } from '#lib/server/request-utils.js';

interface SearchResult {
	type: 'invoice' | 'proposal' | 'client' | 'expense' | 'ticket' | 'monitor' | 'catalog_item';
	id: string;
	title: string;
	subtitle: string;
	href: string;
}

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

function searchEntities(
	stmt: ReturnType<typeof db.prepare>,
	pattern: string,
	type: SearchResult['type'],
	extractFn: (data: Record<string, unknown>, id: string) => { title: string; subtitle: string; href: string } | null,
	results: SearchResult[]
): void {
	const rows = stmt.all({ p: pattern }) as { id: string; data: string }[];
	for (const row of rows) {
		try {
			const data = JSON.parse(row.data);
			const extracted = extractFn(data, row.id);
			if (extracted) results.push({ type, id: row.id, ...extracted });
		} catch (e) {
			console.warn(`Search: corrupt ${type} ${row.id}:`, e instanceof Error ? e.message : e);
		}
	}
}

export const GET: RequestHandler = async ({ url, locals }) => {
	requireUser(locals);

	const q = (url.searchParams.get('q') ?? '').trim().toLowerCase().slice(0, 200);
	if (q.length < 2) return json([]);

	const pattern = `%${escapeSqlLike(q)}%`;
	const lang = getSetting<GeneralSettings>('general').language || 'en';
	const st = serverT(lang);
	const results: SearchResult[] = [];

	searchEntities(searchInvoicesStmt, pattern, 'invoice', (inv, id) => ({
		title: inv.documentId as string,
		subtitle: `${(inv.buyer as Record<string, unknown>)?.name ?? ''} — ${inv.status}`,
		href: `/invoices/${id}`
	}), results);

	searchEntities(searchProposalsStmt, pattern, 'proposal', (prop, id) => ({
		title: prop.documentId as string,
		subtitle: `${(prop.buyer as Record<string, unknown>)?.name ?? ''} — ${prop.status}`,
		href: `/proposals/${id}`
	}), results);

	searchEntities(searchClientsStmt, pattern, 'client', (client, id) => ({
		title: client.name as string,
		subtitle: (client.clientNumber || client.email || '') as string,
		href: `/clients/${id}`
	}), results);

	searchEntities(searchExpensesStmt, pattern, 'expense', (exp) => ({
		title: exp.description as string,
		subtitle: `${exp.vendor || exp.category || st('search.uncategorized')} — ${exp.date}`,
		href: `/expenses`
	}), results);

	searchEntities(searchTicketsStmt, pattern, 'ticket', (ticket) => ({
		title: ticket.title ? `${ticket.ticketNumber} · ${ticket.title}` : ticket.ticketNumber as string,
		subtitle: `${ticket.date} — ${ticket.status}`,
		href: `/tickets`
	}), results);

	searchEntities(searchMonitorsStmt, pattern, 'monitor', (mon) => ({
		title: mon.name as string,
		subtitle: [mon.ip, mon.domain].filter(Boolean).join(' / '),
		href: `/uptime`
	}), results);

	searchEntities(searchCatalogItemsStmt, pattern, 'catalog_item', (item) => ({
		title: item.name as string,
		subtitle: (item.description || '') as string,
		href: `/catalog`
	}), results);

	return json(results.slice(0, 20));
};
