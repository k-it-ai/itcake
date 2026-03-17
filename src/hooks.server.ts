import type { Handle, HandleServerError } from '@sveltejs/kit';
import { error, isHttpError } from '@sveltejs/kit';
import { env } from '$env/dynamic/private';
import { getSession, cleanExpiredSessions } from '$lib/server/auth.js';
import { processDueRecurringInvoices } from '$services/recurring-invoices.js';
import { markOverdueInvoices } from '$services/invoices.js';
import { db } from '$lib/server/db.js';
import { runChecks, runDailyChecks } from '$services/monitor-checks.js';
import { aggregateMonitorDaily, pruneOldMonitorChecks } from '$services/monitors.js';

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
	runDailyChecks().catch(e => console.error('Daily monitor checks failed:', e));
	try { aggregateMonitorDaily(); } catch (e) { console.error('Monitor aggregation failed:', e); }
	try { pruneOldMonitorChecks(); } catch (e) { console.error('Monitor check pruning failed:', e); }
}, 24 * 60 * 60 * 1000).unref();

// Startup: delayed initial monitor checks
setTimeout(() => {
	runChecks().catch(e => console.error('Startup monitor checks failed:', e));
	runDailyChecks().catch(e => console.error('Startup daily checks failed:', e));
	try { aggregateMonitorDaily(); } catch (e) { console.error('Startup aggregation failed:', e); }
}, 15_000).unref();

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

	const response = await resolve(event);

	// Security headers on all responses
	response.headers.set('X-Content-Type-Options', 'nosniff');
	response.headers.set('X-Frame-Options', 'SAMEORIGIN');
	response.headers.set('Referrer-Policy', 'strict-origin-when-cross-origin');
	response.headers.set('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
	response.headers.set('X-Permitted-Cross-Domain-Policies', 'none');
	response.headers.set('Cross-Origin-Opener-Policy', 'same-origin');

	// HSTS — only in production (avoids breaking localhost HTTP)
	if (env.NODE_ENV !== 'development') {
		response.headers.set('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
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
