/**
 * Optional Sentry-compatible error reporter.
 *
 * Wire format: when settings.telemetry.errorReportingDsn is set, we POST
 * an envelope to <ingestHost>/api/<projectId>/envelope/ keyed by the DSN
 * public key. No SDK dependency — Sentry's envelope schema is stable and
 * the surface we need (one event-type event with exception + tags) is
 * small. Operators who want richer instrumentation can keep their own
 * client; this is "production crashes show up somewhere" out of the box.
 *
 * Sampling: 1.0 by default; configurable via settings.telemetry.sampleRate.
 * Privacy: payload carries only message + stack + tag context. Request
 * bodies and headers are never sent.
 */
import { getSetting } from './db.js';
import { log } from './log.js';
import { pinnedHttpsRequest } from './pinned-https.js';
import type { TelemetrySettings } from '$lib/types.js';

interface ParsedDsn {
	publicKey: string;
	host: string;
	projectId: string;
	protocol: 'https:' | 'http:';
}

function parseDsn(dsn: string): ParsedDsn | null {
	try {
		const u = new URL(dsn);
		if (u.protocol !== 'https:') return null;
		const publicKey = u.username;
		const projectId = u.pathname.replace(/^\//, '').split('/').pop();
		if (!publicKey || !projectId) return null;
		return { publicKey, host: u.host, projectId, protocol: 'https:' };
	} catch { return null; }
}

let throttleUntilMs = 0;

export interface ErrorContext {
	requestId?: string;
	path?: string;
	method?: string;
	userId?: string;
	[k: string]: unknown;
}

export function reportError(err: unknown, ctx: ErrorContext = {}): void {
	const settings = getSetting<TelemetrySettings>('telemetry');
	if (!settings?.errorReportingDsn) return;
	if (Date.now() < throttleUntilMs) return;

	const sampleRate = typeof settings.sampleRate === 'number'
		? Math.max(0, Math.min(1, settings.sampleRate))
		: 1;
	if (Math.random() > sampleRate) return;

	const parsed = parseDsn(settings.errorReportingDsn);
	if (!parsed) return;

	void sendEnvelope(parsed, err, ctx).catch(e => {
		log.warn('[error-reporter] send failed', { err: e instanceof Error ? e.message : String(e) });
		throttleUntilMs = Date.now() + 5 * 60_000;
	});
}

async function sendEnvelope(dsn: ParsedDsn, err: unknown, ctx: ErrorContext): Promise<void> {
	const eventId = crypto.randomUUID().replace(/-/g, '');
	const now = new Date();
	const errObj = err instanceof Error ? err : new Error(String(err));

	const event = {
		event_id: eventId,
		timestamp: now.getTime() / 1000,
		level: 'error',
		platform: 'node',
		environment: process.env.NODE_ENV || 'production',
		server_name: process.env.HOST || 'itcake',
		exception: {
			values: [{
				type: errObj.name || 'Error',
				value: String(errObj.message || err).slice(0, 1000),
				stacktrace: errObj.stack ? { frames: parseStack(errObj.stack) } : undefined
			}]
		},
		tags: Object.fromEntries(Object.entries(ctx).filter(([, v]) => typeof v === 'string' || typeof v === 'number').map(([k, v]) => [k, String(v).slice(0, 200)])),
		release: 'itcake'
	};

	const envelopeHeader = JSON.stringify({ event_id: eventId, sent_at: now.toISOString() });
	const itemHeader = JSON.stringify({ type: 'event', length: Buffer.byteLength(JSON.stringify(event)) });
	const body = `${envelopeHeader}\n${itemHeader}\n${JSON.stringify(event)}\n`;

	const url = `${dsn.protocol}//${dsn.host}/api/${dsn.projectId}/envelope/`;
	const headers: Record<string, string> = {
		'Content-Type': 'application/x-sentry-envelope',
		'X-Sentry-Auth': `Sentry sentry_version=7,sentry_key=${dsn.publicKey},sentry_client=itcake/1.0`,
		'Content-Length': String(Buffer.byteLength(body))
	};
	const r = await pinnedHttpsRequest({ url, method: 'POST', headers, body, timeoutMs: 5_000, maxBodyBytes: 16 * 1024 });
	if (r.status >= 400) {
		log.warn('[error-reporter] non-2xx', { status: r.status });
	}
}

function parseStack(stack: string): Array<{ filename?: string; function?: string; lineno?: number }> {
	const lines = stack.split('\n').slice(1, 31);
	const frames: ReturnType<typeof parseStack> = [];
	for (const l of lines) {
		const m = l.match(/at (?:([^(]+) \()?(.+?):(\d+):\d+\)?/);
		if (!m) continue;
		const [, fn, file, line] = m;
		frames.push({ function: fn?.trim(), filename: file?.trim(), lineno: Number(line) });
	}
	return frames.reverse();
}
