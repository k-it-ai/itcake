import type { PageServerLoad } from './$types.js';
import { redirect } from '@sveltejs/kit';
import { getRevenueReport, getClientReport, getTaxReport, getExpenseReport } from '#services/reports.js';
import { getSetting } from '#lib/server/db.js';

export const load: PageServerLoad = async ({ url, locals }) => {
	if (!locals.user) throw redirect(302, '/login');
	const currentYear = new Date().getFullYear();
	const parsedYear = parseInt(url.searchParams.get('year') ?? String(currentYear), 10);
	const year = Math.min(Math.max(isNaN(parsedYear) ? currentYear : parsedYear, 2000), currentYear + 5);
	const general = getSetting<{ currency?: string; kleinunternehmer?: boolean }>('general');
	const advanced = getSetting<{ kleinunternehmer?: boolean }>('advanced');

	const currency = general.currency ?? 'EUR';
	return {
		year,
		currentYear,
		currency,
		isKleinunternehmer: advanced.kleinunternehmer ?? false,
		revenue: getRevenueReport(year, currency),
		clients: getClientReport(year, currency),
		tax: getTaxReport(year, currency),
		expenses: getExpenseReport(year, currency)
	};
};
