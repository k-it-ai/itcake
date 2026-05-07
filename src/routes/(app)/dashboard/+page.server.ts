import type { PageServerLoad } from './$types.js';
import { redirect } from '@sveltejs/kit';
import { getDashboardStats } from '$services/invoices.js';
import { getAgentSummary } from '$services/agents.js';
import { getRecoveryReadiness, listBackupVerifications } from '$services/backup-verification.js';
import { db } from '$lib/server/db.js';
import dayjs from 'dayjs';

const stmtClientCount = db.prepare("SELECT COUNT(*) as c FROM documents WHERE type = 'client'");

export const load: PageServerLoad = async ({ locals, parent }) => {
	if (!locals.user) throw redirect(302, '/login');

	const parentData = await parent();
	const settings = parentData.settings;
	const defaultCurrency = settings.general?.currency || 'EUR';
	const currentYear = dayjs().year();
	const isKleinunternehmer = settings.advanced?.kleinunternehmer ?? false;

	const dashboard = getDashboardStats(defaultCurrency, currentYear, isKleinunternehmer);

	const totalClients = (stmtClientCount.get() as { c: number }).c;
	const yearlyRevenue = dashboard.monthlyRevenue.reduce((a, b) => a + b, 0);
	const yearlyTax = dashboard.monthlyTax.reduce((a, b) => a + b, 0);
	const dayOfMonth = dayjs().date();
	const daysInMonth = dayjs().daysInMonth();
	const monthsElapsed = dayjs().month() + (dayOfMonth / daysInMonth);
	const avgPerMonth = monthsElapsed > 0 ? Math.round(yearlyRevenue / monthsElapsed) : 0;

	const agentSummary = getAgentSummary();
	const recoveryReadiness = getRecoveryReadiness();
	const recentVerifications = listBackupVerifications(5);

	return {
		...dashboard,
		totalClients,
		currentYear,
		yearlyRevenue,
		yearlyTax,
		avgPerMonth,
		isKleinunternehmer,
		agentSummary,
		recoveryReadiness,
		recentVerifications
	};
};
