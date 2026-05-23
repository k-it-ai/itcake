import { db, getSetting } from '$lib/server/db.js';
import { serverT } from '$lib/i18n/server.js';
import type { Invoice, Expense, GeneralSettings } from '$lib/types.js';

// Includes credit notes — their negative totals must reduce reported revenue
// and tax (the alternative — listing them separately — desyncs the dashboard
// total from the per-month table).
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

interface RevenueReport {
	monthly: MonthlyRow[];
	totalRevenue: number;
	totalTax: number;
	totalInvoices: number;
}

interface ClientReport {
	clients: ClientRow[];
}

interface TaxReport {
	monthly: { month: string; taxCollected: number; netRevenue: number }[];
	totalTax: number;
	totalNet: number;
}

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

	let nullPaidDateCount = 0;
	for (const row of rows) {
		const inv = JSON.parse(row.data) as Invoice;
		if (!inv.paidDate) nullPaidDateCount++;
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
		if (inv.invoiceType !== 'creditNote') {
			monthly[monthKey].count++;
			totalInvoices++;
		}

		if (!byCurrency[cur]) byCurrency[cur] = { revenue: 0, tax: 0, count: 0 };
		byCurrency[cur].revenue += revenue;
		byCurrency[cur].tax += tax;
		if (inv.invoiceType !== 'creditNote') {
			byCurrency[cur].count++;
		}
	}
	if (nullPaidDateCount > 0) {
		console.warn(`[reports] ${nullPaidDateCount} paid invoice(s) had null paidDate; bucketed by issueDate`);
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

	let nullPaidDateCountTax = 0;
	for (const row of rows) {
		const inv = JSON.parse(row.data) as Invoice;
		if (!inv.paidDate) nullPaidDateCountTax++;
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
	if (nullPaidDateCountTax > 0) {
		console.warn(`[reports] ${nullPaidDateCountTax} paid invoice(s) had null paidDate; bucketed by issueDate (tax report)`);
	}

	return {
		monthly: Object.values(monthly),
		totalTax,
		totalNet
	};
}

interface ExpenseReport {
	monthly: { month: string; amount: number; count: number }[];
	byCategory: { category: string; amount: number; count: number }[];
	totalExpenses: number;
	totalCount: number;
}

export function getExpenseReport(year: number, currency?: string): ExpenseReport & {
	mixedCurrencies: boolean;
	byCurrency: Record<string, { amount: number; count: number }>;
} {
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
	const currenciesSeen = new Set<string>();
	const byCurrency: Record<string, { amount: number; count: number }> = {};

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
		// Track per-currency totals so the dashboard can warn-or-split
		// the same way getRevenueReport does. A caller that omits the
		// currency filter previously got a silently-mixed sum; now they
		// can detect that and split.
		const cur = exp.currency || 'EUR';
		currenciesSeen.add(cur);
		if (!byCurrency[cur]) byCurrency[cur] = { amount: 0, count: 0 };
		byCurrency[cur].amount += exp.amount;
		byCurrency[cur].count++;
	}

	return {
		monthly: Object.values(monthly),
		byCategory: Object.values(catMap).sort((a, b) => b.amount - a.amount),
		totalExpenses,
		totalCount,
		mixedCurrencies: currenciesSeen.size > 1,
		byCurrency
	};
}
