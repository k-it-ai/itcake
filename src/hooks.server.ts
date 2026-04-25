import type { Handle, HandleServerError } from '@sveltejs/kit';
import { error, isHttpError } from '@sveltejs/kit';
import { env } from '$env/dynamic/private';
import { getSession, cleanExpiredSessions } from '$lib/server/auth.js';
import { processDueRecurringInvoices } from '$services/recurring-invoices.js';
import { markOverdueInvoices } from '$services/invoices.js';
import { db, getSetting } from '$lib/server/db.js';
import type { GeneralSettings } from '$lib/types.js';
import { runChecks, runDailyChecks } from '$services/monitor-checks.js';
import { aggregateMonitorDaily, pruneOldMonitorChecks } from '$services/monitors.js';
import { detectStaleAgents } from '$services/agents.js';
import { aggregateAgentMetricsDaily, pruneOldAgentMetrics } from '$services/agent-metrics.js';
import { pruneOldAgentEvents } from '$services/agent-events.js';
import { expirePendingCommands } from '$services/agent-commands.js';
import { processAutoUpdates } from '$services/agent-auto-update.js';
import { processDueSchedules } from '$services/agent-schedules.js';
import { evaluateAlertRules } from '$services/alerts.js';

const stmtPruneAuditLog = db.prepare("DELETE FROM changes WHERE created_at < datetime('now', '-365 days')");

// Clean expired sessions every hour
setInterval(() => {
	try { cleanExpiredSessions(); } catch (e) { console.error('Session cleanup failed:', e); }
}, 60 * 60 * 1000).unref();
try { cleanExpiredSessions(); } catch (e) { console.error('Initial session cleanup failed:', e); }

// Process recurring invoices and mark overdue every hour
setInterval(() => {
	try { processDueRecurringInvoices('system'); } catch (e) { console.error('Recurring invoice processing failed:', e); }
	try { markOverdueInvoices('system'); } catch (e) { console.error('Overdue invoice marking failed:', e); }
}, 60 * 60 * 1000).unref();

// Prune audit log entries older than 1 year (daily)
setInterval(() => {
	try { stmtPruneAuditLog.run(); } catch (e) { console.error('Audit log pruning failed:', e); }
}, 24 * 60 * 60 * 1000).unref();
// Also run once at startup (delayed 10s to let DB initialize)
setTimeout(() => {
	try { processDueRecurringInvoices('system'); } catch (e) { console.error('Startup recurring invoice processing failed:', e); }
	try { markOverdueInvoices('system'); } catch (e) { console.error('Startup overdue invoice marking failed:', e); }
}, 10_000).unref();

// Uptime monitoring checks every 60 seconds
setInterval(() => {
	runChecks().catch(e => console.error('Monitor checks failed:', e));
}, 60_000).unref();

// Daily: domain/SSL expiry + aggregation + pruning
setInterval(() => {
	runDailyChecks()
		.catch(e => console.error('Daily monitor checks failed:', e))
		.finally(() => {
			try { aggregateMonitorDaily(); } catch (e) { console.error('Monitor aggregation failed:', e); }
			try { pruneOldMonitorChecks(); } catch (e) { console.error('Monitor check pruning failed:', e); }
		});
}, 24 * 60 * 60 * 1000).unref();

// Startup: delayed initial monitor checks
setTimeout(async () => {
	try { await runChecks(); } catch (e) { console.error('Startup monitor checks failed:', e); }
	try { await runDailyChecks(); } catch (e) { console.error('Startup daily checks failed:', e); }
	try { aggregateMonitorDaily(); } catch (e) { console.error('Startup aggregation failed:', e); }
}, 15_000).unref();

// RMM: Stale agent detection + command expiry + due-schedule dispatch every 60s.
// Schedules use 1-minute cron resolution, so we tick at the same cadence.
setInterval(() => {
	try { detectStaleAgents(); } catch (e) { console.error('Agent stale detection failed:', e); }
	try { expirePendingCommands(); } catch (e) { console.error('Command expiry failed:', e); }
	try { processDueSchedules(); } catch (e) { console.error('Schedule processing failed:', e); }
	try { evaluateAlertRules(); } catch (e) { console.error('Alert evaluation failed:', e); }
}, 60_000).unref();

// RMM: Auto-update scheduling — hourly tick; the decision lives in
// agent-auto-update.ts (pure function + DB wrapper). Uses a dedicated
// `last_auto_update_at` column so that ordinary check-ins, which bump
// `updated_at`, don't keep resetting the interval clock.
setInterval(() => {
	try { processAutoUpdates(); } catch (e) { console.error('Auto-update scheduling failed:', e); }
}, 60 * 60 * 1000).unref();

// RMM: Daily metrics aggregation + pruning + event-log pruning
setInterval(() => {
	try { aggregateAgentMetricsDaily(); } catch (e) { console.error('Agent metrics aggregation failed:', e); }
	try { pruneOldAgentMetrics(); } catch (e) { console.error('Agent metrics pruning failed:', e); }
	try { pruneOldAgentEvents(); } catch (e) { console.error('Agent events pruning failed:', e); }
}, 24 * 60 * 60 * 1000).unref();

// Warm up Puppeteer browser in background so template previews load instantly
setTimeout(() => {
	import('$lib/server/pdf.js').catch((e) => {
		console.error('Puppeteer warm-up failed:', e instanceof Error ? e.message : e);
	});
}, 3_000).unref();

/**
 * CSRF protection for all state-changing requests.
 * Validates Origin (or Referer fallback) matches the app's origin
 * for POST/PUT/PATCH/DELETE to any endpoint (API routes + form actions).
 */
function validateOrigin(event: Parameters<Handle>[0]['event']): void {
	const method = event.request.method;
	if (method === 'GET' || method === 'HEAD' || method === 'OPTIONS') return;

	// CSRF exemption: agent-facing endpoints use bearer token auth, not cookies
	if (event.url.pathname.startsWith('/api/rmm/')) return;

	const origin = event.request.headers.get('origin');
	if (origin) {
		if (origin !== event.url.origin) {
			throw error(403, 'Cross-origin request rejected');
		}
		return;
	}

	// Fallback: check Referer header (some same-origin requests omit Origin)
	const referer = event.request.headers.get('referer');
	if (referer) {
		try {
			const refererUrl = new URL(referer);
			if (refererUrl.origin !== event.url.origin) {
				throw error(403, 'Cross-origin request rejected');
			}
			return;
		} catch (e) {
			// Re-throw SvelteKit HttpError (cross-origin rejection above)
			if (isHttpError(e)) throw e;
			throw error(403, 'Invalid referer');
		}
	}

	// Neither Origin nor Referer present — reject to be safe
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
	// CSRF check for state-changing API requests
	validateOrigin(event);

	// Attach user session to all requests
	const user = getSession(event.cookies);
	event.locals.user = user;

	const rawLang = getSetting<GeneralSettings>('general')?.language || 'en';
	const lang = /^[a-z]{2}(-[A-Z]{2,4})?$/.test(rawLang) ? rawLang : 'en';
	const response = await resolve(event, {
		transformPageChunk: ({ html }) => html.replace('lang="en"', `lang="${lang}"`)
	});

	// Security headers on all responses.
	//
	// - X-Content-Type-Options: nosniff → prevents MIME-type sniffing attacks.
	// - X-Frame-Options + frame-ancestors (CSP) → defense against clickjacking.
	// - Referrer-Policy strict-origin-when-cross-origin → leaks only the origin
	//   off-site, full URL same-origin; keeps query strings out of Referer.
	// - Permissions-Policy → we never need camera/mic/geolocation/etc, so
	//   declaratively deny everything sensitive.
	// - Cross-Origin-Opener-Policy: same-origin → isolates our window group
	//   from any third-party popup, mitigating XSLeaks / Spectre variants.
	// - Cross-Origin-Resource-Policy: same-origin → other origins cannot
	//   embed any of our responses (blocks cross-origin fetches of API JSON
	//   even when CSP/cookies would allow it).
	// - X-Permitted-Cross-Domain-Policies: none → legacy Flash / PDF policy
	//   files are forbidden; cheap belt on top of the main restrictions.
	// - X-DNS-Prefetch-Control: off → don't leak hostname lookups to the
	//   browser's prefetcher for pages we've linked to.
	response.headers.set('X-Content-Type-Options', 'nosniff');
	response.headers.set('X-Frame-Options', 'SAMEORIGIN');
	response.headers.set('Referrer-Policy', 'strict-origin-when-cross-origin');
	response.headers.set('Permissions-Policy', 'camera=(), microphone=(), geolocation=(), payment=(), usb=(), bluetooth=(), interest-cohort=()');
	response.headers.set('X-Permitted-Cross-Domain-Policies', 'none');
	response.headers.set('Cross-Origin-Opener-Policy', 'same-origin');
	response.headers.set('Cross-Origin-Resource-Policy', 'same-origin');
	response.headers.set('X-DNS-Prefetch-Control', 'off');

	if (!response.headers.has('cache-control')) {
		if (event.url.pathname.startsWith('/api/') || event.locals.user) {
			response.headers.set('Cache-Control', 'no-store');
		}
	}

	// HSTS — only in production (avoids breaking localhost HTTP)
	if (env.NODE_ENV !== 'development') {
		response.headers.set('Strict-Transport-Security', 'max-age=31536000; includeSubDomains; preload');
	}

	// CSP: stricter for HTML preview/PDF endpoints, restrictive for API.
	// App pages get CSP from SvelteKit's built-in nonce-based config (svelte.config.js csp).
	// We only set manual CSP for /api/ routes where SvelteKit's CSP doesn't apply.
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
		// Fallback CSP for pages SvelteKit's csp config doesn't cover (e.g. error pages).
		// style-src needs 'unsafe-inline' for Tailwind/Svelte component styles.
		response.headers.set(
			'Content-Security-Policy',
			"default-src 'self'; style-src 'self' 'unsafe-inline'; font-src 'self' data:; img-src 'self' data: blob:; script-src 'self'; connect-src 'self'; frame-src 'self'; frame-ancestors 'self'; form-action 'self'; base-uri 'self'"
		);
	}

	return response;
};
