import { db, getSetting } from '$lib/server/db.js';
import { serverT } from '$lib/i18n/server.js';
import type { Invoice, Expense, GeneralSettings } from '$lib/types.js';

// Pre-cached prepared statements for report queries (2 variants: with/without currency filter)
// NOTE: Includes both invoices AND credit notes so credit note totals (negative) reduce reported revenue.
// Excluding credit notes would overstate revenue when invoices are partially or fully reversed.
const baseInvoiceReportSql = (currencyClause: string) => `
	SELECT data FROM documents
	WHERE type = 'invoice'
	AND json_extract(data, '$.status') = 'paid'
	AND COALESCE(json_extract(data, '$.paidDate'), json_extract(data, '$.issueDate')) >= ?
	AND COALESCE(json_extract(data, '$.paidDate'), json_extract(data, '$.issueDate')) < ?
	${currencyClause}
`;

const stmtInvoiceReport = db.prepare(baseInvoiceReportSql(''));
const stmtInvoiceReportCurrency = db.prepare(baseInvoiceReportSql("AND json_extract(data, '$.currency') = ?"));
const stmtExpenseReport = db.prepare(`
	SELECT data FROM documents
	WHERE type = 'expense'
	AND json_extract(data, '$.date') >= ?
	AND json_extract(data, '$.date') < ?
`);
const stmtExpenseReportCurrency = db.prepare(`
	SELECT data FROM documents
	WHERE type = 'expense'
	AND json_extract(data, '$.date') >= ?
	AND json_extract(data, '$.date') < ?
	AND json_extract(data, '$.currency') = ?
`);

interface MonthlyRow {
	month: string;
	revenue: number;
	tax: number;
	count: number;
}

interface ClientRow {
	clientId: string;
	clientName: string;
	revenue: number;
	invoiceCount: number;
}

export interface RevenueReport {
	monthly: MonthlyRow[];
	totalRevenue: number;
	totalTax: number;
	totalInvoices: number;
}

export interface ClientReport {
	clients: ClientRow[];
}

export interface TaxReport {
	monthly: { month: string; taxCollected: number; netRevenue: number }[];
	totalTax: number;
	totalNet: number;
}

/**
 * Revenue report by month for a given year.
 * When currency is provided, filters to that single currency.
 * When omitted, includes all currencies — callers should check `mixedCurrencies`
 * in the response to warn the user that totals span multiple currencies.
 */
export function getRevenueReport(year: number, currency?: string): RevenueReport & { mixedCurrencies: boolean; byCurrency: Record<string, { revenue: number; tax: number; count: number }> } {
	const fromDate = `${year}-01-01`;
	const toDate = `${year + 1}-01-01`;
	const rows = currency
		? stmtInvoiceReportCurrency.all(fromDate, toDate, currency) as { data: string }[]
		: stmtInvoiceReport.all(fromDate, toDate) as { data: string }[];

	const monthly: Record<string, MonthlyRow> = {};
	for (let m = 0; m < 12; m++) {
		const key = `${year}-${String(m + 1).padStart(2, '0')}`;
		monthly[key] = { month: key, revenue: 0, tax: 0, count: 0 };
	}

	let totalRevenue = 0;
	let totalTax = 0;
	let totalInvoices = 0;
	const currenciesSeen = new Set<string>();
	const byCurrency: Record<string, { revenue: number; tax: number; count: number }> = {};

	for (const row of rows) {
		const inv = JSON.parse(row.data) as Invoice;
		if (!inv.paidDate) {
			console.warn(`[reports] Paid invoice ${inv.id} has null paidDate — falling back to issueDate for period bucketing`);
		}
		const paidDate = inv.paidDate || inv.issueDate;
		const monthKey = paidDate.substring(0, 7);
		if (!monthly[monthKey]) continue;

		const cur = inv.currency || 'EUR';
		currenciesSeen.add(cur);

		const revenue = inv.totals?.total ?? 0;
		const tax = inv.totals?.totalTaxes ?? 0;
		monthly[monthKey].revenue += revenue;
		monthly[monthKey].tax += tax;
		totalRevenue += revenue;
		totalTax += tax;
		// Count regular invoices and credit notes separately — credit note totals
		// (negative) correctly reduce revenue, but shouldn't inflate the invoice count
		if (inv.invoiceType !== 'creditNote') {
			monthly[monthKey].count++;
			totalInvoices++;
		}

		// Per-currency breakdown (useful when mixed currencies are present)
		if (!byCurrency[cur]) byCurrency[cur] = { revenue: 0, tax: 0, count: 0 };
		byCurrency[cur].revenue += revenue;
		byCurrency[cur].tax += tax;
		if (inv.invoiceType !== 'creditNote') {
			byCurrency[cur].count++;
		}
	}

	return {
		monthly: Object.values(monthly),
		totalRevenue,
		totalTax,
		totalInvoices,
		mixedCurrencies: currenciesSeen.size > 1,
		byCurrency
	};
}

/**
 * Revenue breakdown by client for a given year.
 */
export function getClientReport(year: number, currency?: string): ClientReport {
	const fromDate = `${year}-01-01`;
	const toDate = `${year + 1}-01-01`;
	const rows = currency
		? stmtInvoiceReportCurrency.all(fromDate, toDate, currency) as { data: string }[]
		: stmtInvoiceReport.all(fromDate, toDate) as { data: string }[];

	const clientMap: Record<string, ClientRow> = {};

	for (const row of rows) {
		const inv = JSON.parse(row.data) as Invoice;

		const cid = inv.clientId || 'unknown';
		const cname = inv.buyer?.name || serverT(getSetting<GeneralSettings>('general').language || 'en')('search.unknownClient');
		if (!clientMap[cid]) {
			clientMap[cid] = { clientId: cid, clientName: cname, revenue: 0, invoiceCount: 0 };
		}
		clientMap[cid].revenue += inv.totals?.total ?? 0;
		if (inv.invoiceType !== 'creditNote') {
			clientMap[cid].invoiceCount++;
		}
	}

	const clients = Object.values(clientMap).sort((a, b) => b.revenue - a.revenue);
	return { clients };
}

/**
 * Tax summary by month for a given year.
 */
export function getTaxReport(year: number, currency?: string): TaxReport {
	const fromDate = `${year}-01-01`;
	const toDate = `${year + 1}-01-01`;
	const rows = currency
		? stmtInvoiceReportCurrency.all(fromDate, toDate, currency) as { data: string }[]
		: stmtInvoiceReport.all(fromDate, toDate) as { data: string }[];

	const monthly: Record<string, { month: string; taxCollected: number; netRevenue: number }> = {};
	for (let m = 0; m < 12; m++) {
		const key = `${year}-${String(m + 1).padStart(2, '0')}`;
		monthly[key] = { month: key, taxCollected: 0, netRevenue: 0 };
	}

	let totalTax = 0;
	let totalNet = 0;

	for (const row of rows) {
		const inv = JSON.parse(row.data) as Invoice;
		if (!inv.paidDate) {
			console.warn(`[reports] Paid invoice ${inv.id} has null paidDate — falling back to issueDate for tax period bucketing`);
		}
		const paidDate = inv.paidDate || inv.issueDate;
		const monthKey = paidDate.substring(0, 7);
		if (!monthly[monthKey]) continue;

		const tax = inv.totals?.totalTaxes ?? 0;
		const net = inv.totals?.netTotal ?? ((inv.totals?.total ?? 0) - tax);
		monthly[monthKey].taxCollected += tax;
		monthly[monthKey].netRevenue += net;
		totalTax += tax;
		totalNet += net;
	}

	return {
		monthly: Object.values(monthly),
		totalTax,
		totalNet
	};
}

export interface ExpenseReport {
	monthly: { month: string; amount: number; count: number }[];
	byCategory: { category: string; amount: number; count: number }[];
	totalExpenses: number;
	totalCount: number;
}

/**
 * Expense report by month and category for a given year.
 */
export function getExpenseReport(year: number, currency?: string): ExpenseReport {
	const rows = currency
		? stmtExpenseReportCurrency.all(`${year}-01-01`, `${year + 1}-01-01`, currency) as { data: string }[]
		: stmtExpenseReport.all(`${year}-01-01`, `${year + 1}-01-01`) as { data: string }[];

	const monthly: Record<string, { month: string; amount: number; count: number }> = {};
	for (let m = 0; m < 12; m++) {
		const key = `${year}-${String(m + 1).padStart(2, '0')}`;
		monthly[key] = { month: key, amount: 0, count: 0 };
	}

	const catMap: Record<string, { category: string; amount: number; count: number }> = {};
	let totalExpenses = 0;
	let totalCount = 0;

	for (const row of rows) {
		const exp = JSON.parse(row.data) as Expense;
		const monthKey = exp.date.substring(0, 7);
		if (monthly[monthKey]) {
			monthly[monthKey].amount += exp.amount;
			monthly[monthKey].count++;
		}
		if (!catMap[exp.category]) {
			catMap[exp.category] = { category: exp.category, amount: 0, count: 0 };
		}
		catMap[exp.category].amount += exp.amount;
		catMap[exp.category].count++;
		totalExpenses += exp.amount;
		totalCount++;
	}

	return {
		monthly: Object.values(monthly),
		byCategory: Object.values(catMap).sort((a, b) => b.amount - a.amount),
		totalExpenses,
		totalCount
	};
}
