import crypto from 'node:crypto';
import type { RequestHandler } from './$types.js';
import { SESSION_SECRET } from '$app/env/private';
import { log } from '#lib/server/log.js';
import { checkAndRecordWindowed } from '#lib/server/rate-limit.js';

function hashedIp(ip: string): string {
	const secret = SESSION_SECRET || 'csp-report-fallback-not-secret';
	return 'h:' + crypto.createHmac('sha256', secret).update(ip).digest('hex').slice(0, 16);
}

const MAX_BODY_BYTES = 16 * 1024;

export const POST: RequestHandler = async ({ request, getClientAddress }) => {
	const ip = getClientAddress();
	const r = checkAndRecordWindowed(`csp-report:${ip}`, 60, 60_000);
	if (!r.ok) return new Response(null, { status: 204 });

	const cl = request.headers.get('content-length');
	if (cl && Number(cl) > MAX_BODY_BYTES) return new Response(null, { status: 413 });

	let text = '';
	try {
		text = await request.text();
	} catch {
		return new Response(null, { status: 204 });
	}
	if (text.length > MAX_BODY_BYTES) text = text.slice(0, MAX_BODY_BYTES);

	let parsed: unknown;
	try { parsed = JSON.parse(text); } catch { parsed = { raw: text.slice(0, 500) }; }

	const report = pickReportFields(parsed);
	log.warn('[csp-violation]', { ip: hashedIp(ip), ...report });
	return new Response(null, { status: 204 });
};

function pickReportFields(p: unknown): Record<string, unknown> {
	if (!p || typeof p !== 'object') return {};
	const o = p as Record<string, unknown>;
	const body = (o['csp-report'] as Record<string, unknown>) ?? (o.body as Record<string, unknown>) ?? o;
	if (!body || typeof body !== 'object') return {};
	const keys = [
		'document-uri', 'documentURL',
		'violated-directive', 'effectiveDirective',
		'blocked-uri', 'blockedURL',
		'source-file', 'sourceFile',
		'line-number', 'lineNumber',
		'column-number', 'columnNumber',
		'script-sample', 'sample',
		'disposition'
	];
	const out: Record<string, unknown> = {};
	for (const k of keys) {
		const v = (body as Record<string, unknown>)[k];
		if (v != null) out[k] = typeof v === 'string' ? v.slice(0, 500) : v;
	}
	return out;
}
