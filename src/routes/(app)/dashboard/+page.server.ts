import type { PageServerLoad } from './$types.js';
import { redirect } from '@sveltejs/kit';
import { getInvoices } from '$services/invoices.js';
import { getProposals } from '$services/proposals.js';
import { db } from '$lib/server/db.js';
import dayjs from 'dayjs';

const stmtClientCount = db.prepare("SELECT COUNT(*) as c FROM documents WHERE type = 'client'");

export const load: PageServerLoad = async ({ locals, parent }) => {
	if (!locals.user) throw redirect(302, '/login');

	const parentData = await parent();
	const settings = parentData.settings;
	const defaultCurrency = settings.general?.currency || 'EUR';

	// Single load + single-pass categorization
	const allInvoices = getInvoices();
	const invoices: typeof allInvoices = [];
	const currencyInvoices: typeof allInvoices = [];
	let totalCreditNotes = 0;
	for (const inv of allInvoices) {
		if (inv.invoiceType === 'creditNote') { totalCreditNotes++; continue; }
		invoices.push(inv);
		if (inv.currency === defaultCurrency) currencyInvoices.push(inv);
	}

	let totalDraft = 0, totalSent = 0, totalPaid = 0, totalOverdue = 0;
	for (const inv of invoices) {
		switch (inv.status) {
			case 'draft': totalDraft++; break;
			case 'sent': totalSent++; break;
			case 'paid': totalPaid++; break;
			case 'overdue': totalOverdue++; break;
		}
	}
	const stats = { totalDraft, totalSent, totalPaid, totalOverdue, totalInvoices: invoices.length, totalCreditNotes };

	const recentInvoices = invoices.slice(0, 5);
	const recentProposals = getProposals().slice(0, 5);
	// SQL count avoids loading all client documents just for a number
	const totalClients = (stmtClientCount.get() as { c: number }).c;

	const currentYear = dayjs().year();
	const isKleinunternehmer = settings.advanced?.kleinunternehmer ?? false;

	// Monthly revenue for current year (paid invoices, default currency only)
	const monthlyRevenue: number[] = Array(12).fill(0);
	const monthlyTax: number[] = Array(12).fill(0);

	for (const inv of currencyInvoices) {
		if (inv.status === 'paid') {
			const d = dayjs(inv.paidDate || inv.issueDate);
			if (d.year() === currentYear) {
				const month = d.month();
				monthlyRevenue[month] += inv.totals.total;
				if (!isKleinunternehmer) {
					monthlyTax[month] += inv.totals.totalTaxes;
				}
			}
		}
	}

	// Unpaid invoices (sent + overdue, default currency only for total)
	const unpaidInvoices = invoices
		.filter(inv => inv.status === 'sent' || inv.status === 'overdue')
		.sort((a, b) => {
			const ta = a.dueDate ? new Date(a.dueDate).getTime() : Infinity;
			const tb = b.dueDate ? new Date(b.dueDate).getTime() : Infinity;
			return ta - tb;
		});
	const totalUnpaid = unpaidInvoices
		.filter(inv => inv.currency === defaultCurrency)
		.reduce((sum, inv) => sum + inv.totals.total, 0);

	// Total revenue this year
	const yearlyRevenue = monthlyRevenue.reduce((a, b) => a + b, 0);
	// Weight the current partial month proportionally for more accurate average
	const dayOfMonth = dayjs().date();
	const daysInMonth = dayjs().daysInMonth();
	const monthsElapsed = dayjs().month() + (dayOfMonth / daysInMonth);
	const avgPerMonth = monthsElapsed > 0 ? Math.round(yearlyRevenue / monthsElapsed) : 0;

	// Top 3 clients by revenue (all time, paid invoices in default currency only)
	const clientRevenue = new Map<string, { name: string; total: number }>();
	for (const inv of currencyInvoices) {
		if (inv.status === 'paid') {
			const existing = clientRevenue.get(inv.clientId);
			if (existing) {
				existing.total += inv.totals.total;
			} else {
				clientRevenue.set(inv.clientId, {
					name: inv.buyer?.name || 'Unknown',
					total: inv.totals.total
				});
			}
		}
	}
	const topClients = [...clientRevenue.values()]
		.sort((a, b) => b.total - a.total)
		.slice(0, 3);

	// Yearly tax total
	const yearlyTax = monthlyTax.reduce((a, b) => a + b, 0);

	return {
		stats,
		recentInvoices,
		recentProposals,
		totalClients,
		currentYear,
		monthlyRevenue,
		monthlyTax,
		yearlyRevenue,
		avgPerMonth,
		yearlyTax,
		unpaidInvoices: unpaidInvoices.slice(0, 10),
		totalUnpaid,
		unpaidCount: unpaidInvoices.length,
		topClients,
		isKleinunternehmer
	};
};
