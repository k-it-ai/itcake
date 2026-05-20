import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types.js';
import { db } from '$lib/server/db.js';
import { getFreeDiskSpace } from '$lib/server/disk-usage.js';
import { getPuppeteerHealth } from '$lib/server/pdf.js';
import { isShuttingDown } from '$lib/server/shutdown.js';
import { redactSensitiveInput } from '$lib/server/ai/compaction.js';

const stmtPing = db.prepare('SELECT 1 AS ok');

interface ComponentStatus {
	name: string;
	status: 'ok' | 'degraded' | 'down';
	detail?: string;
}

const LOW_DISK_PERCENT_USED = 90;
const CRITICAL_DISK_PERCENT_USED = 98;

export const GET: RequestHandler = async () => {
	const components: ComponentStatus[] = [];
	let httpStatus = 200;

	try {
		stmtPing.get();
		db.pragma('user_version');
		components.push({ name: 'database', status: 'ok' });
	} catch (e) {
		// Redact + truncate before exposing on the unauthenticated readiness
		// surface. The probe still wants a hint (file-not-found vs. lock vs.
		// corrupt), but raw error text can carry tokens or absolute paths.
		const raw = e instanceof Error ? e.message : String(e);
		components.push({ name: 'database', status: 'down', detail: redactSensitiveInput(raw).slice(0, 200) });
		httpStatus = 503;
	}

	const free = getFreeDiskSpace();
	if (!free) {
		components.push({ name: 'disk', status: 'degraded', detail: 'statfs unavailable' });
	} else if (free.percentUsed >= CRITICAL_DISK_PERCENT_USED) {
		components.push({ name: 'disk', status: 'down', detail: `${free.percentUsed}% used` });
		httpStatus = 503;
	} else if (free.percentUsed >= LOW_DISK_PERCENT_USED) {
		components.push({ name: 'disk', status: 'degraded', detail: `${free.percentUsed}% used` });
	} else {
		components.push({ name: 'disk', status: 'ok', detail: `${free.percentUsed}% used` });
	}

	const puppeteer = await getPuppeteerHealth();
	if (puppeteer === 'connected' || puppeteer === 'not_launched' || puppeteer === 'launching') {
		components.push({ name: 'puppeteer', status: 'ok', detail: puppeteer });
	} else {
		components.push({ name: 'puppeteer', status: 'degraded', detail: puppeteer });
	}

	if (isShuttingDown()) {
		components.push({ name: 'shutdown', status: 'down', detail: 'draining' });
		httpStatus = 503;
	}

	return json(
		{ status: httpStatus === 200 ? 'ok' : 'unhealthy', components, time: new Date().toISOString() },
		{ status: httpStatus, headers: { 'Cache-Control': 'no-store' } }
	);
};
