import type { Handle, HandleServerError } from '@sveltejs/kit';
import { error, isHttpError } from '@sveltejs/kit';
import { env } from '$env/dynamic/private';
import { getSession, cleanExpiredSessions } from '$lib/server/auth.js';
import { processDueRecurringInvoices } from '$services/recurring-invoices.js';
import { markOverdueInvoices } from '$services/invoices.js';
import { db, getSetting } from '$lib/server/db.js';
import { recomputeAuditAnchor, snapshotAuditAnchor, trimAuditAnchorHistoryAbove } from '$lib/server/changes.js';
import type { GeneralSettings } from '$lib/types.js';
import { runChecks, runDailyChecks } from '$services/monitor-checks.js';
import { aggregateMonitorDaily, pruneOldMonitorChecks } from '$services/monitors.js';
import { detectStaleAgents } from '$services/agents.js';
import { pruneOldAgentMetrics } from '$services/agent-metrics.js';
import { pruneOldAgentEvents } from '$services/agent-events.js';
import { expirePendingCommands } from '$services/agent-commands.js';
import { processAutoUpdates } from '$services/agent-auto-update.js';
import { processDueSchedules } from '$services/agent-schedules.js';
import { evaluateAlertRules } from '$services/alerts.js';
import { maybeRunScheduledOffsiteBackup } from '$services/backup-offsite.js';
import { runBackupTestRestore, pickWeeklyTestRestoreCandidate, recomputeRecoveryReadiness } from '$services/backup-verification.js';
import { getBackups } from '$services/backups.js';
import { pruneOldResolvedFindings } from '$services/agent-findings.js';
import { pruneOldCollectorResults } from '$services/agent-collector-results.js';
import { startGuacamoleProxy } from '$services/guacamole.js';
import { pruneExpiredRemoteSessions } from '$services/remote-sessions.js';
import { assertProductionInvariants } from '$lib/server/startup-invariants.js';

assertProductionInvariants(env);

const stmtPruneAuditLog = db.prepare("DELETE FROM changes WHERE created_at < datetime('now', '-365 days')");
const stmtCountChangesForPrune = db.prepare('SELECT COUNT(*) as count FROM changes');
const pruneAuditLogTx = db.transaction(() => {
	const result = stmtPruneAuditLog.run();
	if (result.changes > 0) {
		recomputeAuditAnchor({ allowTruncate: true });
		// Trim history snapshots whose `row_count` exceeds the new live total
		// so `verifyAuditLogIntegrity` doesn't flag the legitimate annual
		// prune as a tail-truncation incident. Snapshots up to the new total
		// are kept; older peak rows from before the prune are deleted.
		const { count } = stmtCountChangesForPrune.get() as { count: number };
		trimAuditAnchorHistoryAbove(count);
	}
});

setInterval(() => {
	try { cleanExpiredSessions(); } catch (e) { console.error('Session cleanup failed:', e); }
}, 60 * 60 * 1000).unref();
try { cleanExpiredSessions(); } catch (e) { console.error('Initial session cleanup failed:', e); }

setInterval(() => {
	try { processDueRecurringInvoices('system'); } catch (e) { console.error('Recurring invoice processing failed:', e); }
	try { markOverdueInvoices('system'); } catch (e) { console.error('Overdue invoice marking failed:', e); }
}, 60 * 60 * 1000).unref();

setInterval(() => {
	try { pruneAuditLogTx(); } catch (e) { console.error('Audit log pruning failed:', e); }
	try { snapshotAuditAnchor(); } catch (e) { console.error('Audit anchor snapshot failed:', e); }
}, 24 * 60 * 60 * 1000).unref();
setTimeout(() => {
	try { processDueRecurringInvoices('system'); } catch (e) { console.error('Startup recurring invoice processing failed:', e); }
	try { markOverdueInvoices('system'); } catch (e) { console.error('Startup overdue invoice marking failed:', e); }
}, 10_000).unref();

setInterval(() => {
	runChecks().catch(e => console.error('Monitor checks failed:', e));
}, 60_000).unref();

setInterval(() => {
	runDailyChecks()
		.catch(e => console.error('Daily monitor checks failed:', e))
		.finally(() => {
			try { aggregateMonitorDaily(); } catch (e) { console.error('Monitor aggregation failed:', e); }
			try { pruneOldMonitorChecks(); } catch (e) { console.error('Monitor check pruning failed:', e); }
		});
}, 24 * 60 * 60 * 1000).unref();

setTimeout(async () => {
	try { await runChecks(); } catch (e) { console.error('Startup monitor checks failed:', e); }
	try { await runDailyChecks(); } catch (e) { console.error('Startup daily checks failed:', e); }
	try { aggregateMonitorDaily(); } catch (e) { console.error('Startup aggregation failed:', e); }
}, 15_000).unref();

let schedulesRunning = false;
let alertsRunning = false;

setInterval(() => {
	try { detectStaleAgents(); } catch (e) { console.error('Agent stale detection failed:', e); }
	try { expirePendingCommands(); } catch (e) { console.error('Command expiry failed:', e); }
	if (!schedulesRunning) {
		schedulesRunning = true;
		try { processDueSchedules(); } catch (e) { console.error('Schedule processing failed:', e); }
		finally { schedulesRunning = false; }
	}
	if (!alertsRunning) {
		alertsRunning = true;
		try { evaluateAlertRules(); } catch (e) { console.error('Alert evaluation failed:', e); }
		finally { alertsRunning = false; }
	}
	try { pruneExpiredRemoteSessions(); } catch (e) { console.error('Remote-session prune failed:', e); }
}, 60_000).unref();

setTimeout(() => {
	try { startGuacamoleProxy(); } catch (e) { console.error('Guacamole proxy startup failed:', e instanceof Error ? e.message : e); }
}, 5_000).unref();

setInterval(() => {
	try { processAutoUpdates(); } catch (e) { console.error('Auto-update scheduling failed:', e); }
}, 60 * 60 * 1000).unref();

// Backup test-restore rotation. We pick a candidate per week-bucket so the
// same backup is exercised once across a 7-day window without a stamp file.
let lastTestRestoreWeek = -1;
async function runWeeklyBackupTestRestore(): Promise<void> {
	const week = Math.floor(Date.now() / (7 * 86400_000));
	if (week === lastTestRestoreWeek) return;
	const filenames = getBackups().map(b => b.filename);
	const candidate = pickWeeklyTestRestoreCandidate(filenames);
	if (!candidate) return;
	lastTestRestoreWeek = week;
	try { await runBackupTestRestore(candidate); }
	catch (e) { console.error('Weekly backup test-restore failed:', e instanceof Error ? e.message : e); }
}

setInterval(() => {
	try { pruneOldAgentMetrics(); } catch (e) { console.error('Agent metrics pruning failed:', e); }
	try { pruneOldAgentEvents(); } catch (e) { console.error('Agent events pruning failed:', e); }
	try { pruneOldResolvedFindings(); } catch (e) { console.error('Agent findings pruning failed:', e); }
	try { pruneOldCollectorResults(); } catch (e) { console.error('Collector results pruning failed:', e); }
	maybeRunScheduledOffsiteBackup().catch(e => console.error('Off-site backup failed:', e instanceof Error ? e.message : e));
	runWeeklyBackupTestRestore().catch(e => console.error('Weekly test-restore failed:', e instanceof Error ? e.message : e));
	try { recomputeRecoveryReadiness(); } catch (e) { console.error('Recovery readiness recompute failed:', e); }
}, 24 * 60 * 60 * 1000).unref();

setTimeout(() => {
	import('$lib/server/pdf.js').catch((e) => {
		console.error('Puppeteer warm-up failed:', e instanceof Error ? e.message : e);
	});
}, 3_000).unref();

function validateOrigin(event: Parameters<Handle>[0]['event']): void {
	const method = event.request.method;
	if (method === 'GET' || method === 'HEAD' || method === 'OPTIONS') return;

	if (event.url.pathname.startsWith('/api/rmm/')) return;

	const origin = event.request.headers.get('origin');
	if (origin) {
		if (origin !== event.url.origin) {
			throw error(403, 'Cross-origin request rejected');
		}
		return;
	}

	const referer = event.request.headers.get('referer');
	if (referer) {
		try {
			const refererUrl = new URL(referer);
			if (refererUrl.origin !== event.url.origin) {
				throw error(403, 'Cross-origin request rejected');
			}
			return;
		} catch (e) {
			if (isHttpError(e)) throw e;
			throw error(403, 'Invalid referer');
		}
	}

	throw error(403, 'Missing origin header');
}

export const handleError: HandleServerError = async ({ error, event }) => {
	const id = crypto.randomUUID();
	console.error(`[${id}] Unhandled error on ${event.request.method} ${event.url.pathname}:`, error);
	return {
		message: 'An internal error occurred',
		id
	};
};

export const handle: Handle = async ({ event, resolve }) => {
	validateOrigin(event);

	const user = getSession(event.cookies);
	event.locals.user = user;

	const rawLang = getSetting<GeneralSettings>('general')?.language || 'en';
	const lang = /^[a-z]{2}(-[A-Z]{2,4})?$/.test(rawLang) ? rawLang : 'en';
	const response = await resolve(event, {
		transformPageChunk: ({ html }) => html.replace('lang="en"', `lang="${lang}"`)
	});

	// Security headers on all responses.
	response.headers.set('X-Content-Type-Options', 'nosniff');
	response.headers.set('X-Frame-Options', 'SAMEORIGIN');
	response.headers.set('Referrer-Policy', 'strict-origin-when-cross-origin');
	response.headers.set('Permissions-Policy', [
		'accelerometer=()', 'ambient-light-sensor=()', 'attribution-reporting=()',
		'autoplay=()', 'battery=()', 'bluetooth=()', 'browsing-topics=()',
		'camera=()', 'clipboard-read=()', 'clipboard-write=()',
		'cross-origin-isolated=()', 'display-capture=()', 'document-domain=()',
		'encrypted-media=()', 'fullscreen=()', 'gamepad=()', 'geolocation=()',
		'gyroscope=()', 'hid=()', 'identity-credentials-get=()',
		'idle-detection=()', 'interest-cohort=()', 'keyboard-map=()',
		'local-fonts=()', 'magnetometer=()', 'microphone=()', 'midi=()',
		'navigation-override=()', 'otp-credentials=()', 'payment=()',
		'picture-in-picture=()', 'publickey-credentials-create=()',
		'publickey-credentials-get=()', 'screen-wake-lock=()', 'serial=()',
		'speaker-selection=()', 'storage-access=()', 'sync-xhr=()',
		'unload=()', 'usb=()', 'web-share=()', 'window-management=()',
		'xr-spatial-tracking=()'
	].join(', '));
	response.headers.set('X-Permitted-Cross-Domain-Policies', 'none');
	response.headers.set('Cross-Origin-Opener-Policy', 'same-origin');
	response.headers.set('Cross-Origin-Resource-Policy', 'same-origin');
	response.headers.set('X-DNS-Prefetch-Control', 'off');
	response.headers.delete('Server');
	response.headers.delete('X-Powered-By');

	if (!response.headers.has('cache-control')) {
		if (event.url.pathname.startsWith('/api/') || event.locals.user) {
			response.headers.set('Cache-Control', 'no-store');
		} else {
			response.headers.set('Cache-Control', 'private, no-cache');
		}
	}
	const existingVary = response.headers.get('Vary');
	if (existingVary && !existingVary.toLowerCase().includes('cookie')) {
		response.headers.set('Vary', existingVary + ', Cookie');
	} else if (!existingVary) {
		response.headers.set('Vary', 'Cookie');
	}

	if (env.NODE_ENV === 'production') {
		response.headers.set('Strict-Transport-Security', 'max-age=31536000; includeSubDomains; preload');
	} else if (env.NODE_ENV !== 'development') {
		// staging / test: HSTS but no preload (preload is permanent across browsers).
		response.headers.set('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
	}

	const path = event.url.pathname;
	const isPreviewOrPdf = path.startsWith('/api/') && (path.endsWith('/preview') || path.endsWith('/pdf'));
	if (isPreviewOrPdf) {
		response.headers.set(
			'Content-Security-Policy',
			"default-src 'none'; style-src 'unsafe-inline'; font-src data:; img-src data: blob:; script-src 'none'; frame-ancestors 'self'; base-uri 'none'"
		);
	} else if (path.startsWith('/api/')) {
		response.headers.set(
			'Content-Security-Policy',
			"default-src 'none'; script-src 'none'; frame-ancestors 'none'; base-uri 'none'"
		);
	} else if (!response.headers.has('content-security-policy')) {
		response.headers.set(
			'Content-Security-Policy',
			"default-src 'self'; style-src 'self' 'unsafe-inline'; font-src 'self' data:; img-src 'self' data: blob:; script-src 'self'; connect-src 'self' wss:; frame-src 'self'; frame-ancestors 'self'; form-action 'self'; base-uri 'self'; object-src 'none'; worker-src 'none'; media-src 'none'; manifest-src 'self'; child-src 'self'"
		);
	}

	return response;
};
