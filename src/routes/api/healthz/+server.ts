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

const DB_PING_TIMEOUT_MS = 2000;

/**
 * better-sqlite3 is synchronous — we can't actually cancel a stuck SELECT
 * (event loop is blocked while it executes). But we can race the resolution
 * via setImmediate so an OS-level wedge (NFS hiccup, fsync stall) doesn't
 * make the readiness probe hang past a sensible deadline.
 *
 * If the timeout wins, the DB call is STILL running in the background; the
 * probe just reports 'down' early so the upstream monitor flips the
 * service out of rotation. Subsequent probes will time out the same way
 * until the DB unblocks.
 */
async function pingDbWithTimeout(): Promise<{ ok: true } | { ok: false; reason: string }> {
	let timer: NodeJS.Timeout | undefined;
	const timeout = new Promise<{ ok: false; reason: string }>((resolve) => {
		timer = setTimeout(() => resolve({ ok: false, reason: `DB ping >${DB_PING_TIMEOUT_MS}ms` }), DB_PING_TIMEOUT_MS);
	});
	const ping = new Promise<{ ok: true } | { ok: false; reason: string }>((resolve) => {
		setImmediate(() => {
			try {
				stmtPing.get();
				db.pragma('user_version');
				resolve({ ok: true });
			} catch (e) {
				const raw = e instanceof Error ? e.message : String(e);
				resolve({ ok: false, reason: redactSensitiveInput(raw).slice(0, 200) });
			}
		});
	});
	try {
		return await Promise.race([ping, timeout]);
	} finally {
		if (timer) clearTimeout(timer);
	}
}

export const GET: RequestHandler = async () => {
	const components: ComponentStatus[] = [];
	let httpStatus = 200;

	const dbResult = await pingDbWithTimeout();
	if (dbResult.ok) {
		components.push({ name: 'database', status: 'ok' });
	} else {
		components.push({ name: 'database', status: 'down', detail: dbResult.reason });
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
