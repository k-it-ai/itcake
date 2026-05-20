import crypto from 'node:crypto';

/**
 * In-memory single-use WS ticket store. The remote-session table in
 * `remote_sessions` is the audited, recording-aware sibling for full
 * remote-desktop sessions; this helper is the bare minimum for any
 * authed WS upgrade where we don't need the durability — AI chat
 * streams, dashboard live updates, future live-tail of agent logs,
 * etc.
 *
 * Threat model (single-process Node):
 *   - Tickets are 32 bytes of OS randomness, base64url-encoded.
 *   - Lookup by raw token (no hash); the in-memory map is process-local
 *     and never persisted.
 *   - consumeTicket atomically reads + deletes. Two concurrent consumers
 *     can never both succeed (single event-loop turn between lookup
 *     and delete).
 *   - Mismatched scope rejects without leaking which tickets exist.
 *   - Reaper sweeps every 60s — tickets with TTLs > 60s see at most
 *     60s + (1 tick) accumulated lifetime past expiry.
 */

interface Ticket<TPayload> {
	scope: string;
	payload: TPayload;
	expiresAt: number;
}

const tickets = new Map<string, Ticket<unknown>>();

const REAPER_INTERVAL_MS = 60_000;

let reaperHandle: ReturnType<typeof setInterval> | null = null;
function ensureReaper(): void {
	if (reaperHandle) return;
	reaperHandle = setInterval(() => {
		const now = Date.now();
		for (const [token, t] of tickets) {
			if (t.expiresAt <= now) tickets.delete(token);
		}
	}, REAPER_INTERVAL_MS);
	if (typeof reaperHandle === 'object' && reaperHandle && 'unref' in reaperHandle) {
		(reaperHandle as { unref?: () => void }).unref?.();
	}
}

const SCOPE_RE = /^[a-z][a-z0-9_-]{1,31}$/;

export interface WsTicket<TPayload = Record<string, unknown>> {
	token: string;
	expiresAt: string;
	scope: string;
	payload: TPayload;
}

/**
 * Issue a one-time ticket. Scope is a free-form lowercase identifier
 * the consumer must match (e.g. 'ai_stream', 'dashboard_live'). TTL
 * is in milliseconds; bounded 1s..30min.
 */
export function issueTicket<TPayload extends object>(scope: string, payload: TPayload, ttlMs: number = 30_000): WsTicket<TPayload> {
	if (!SCOPE_RE.test(scope)) throw new Error(`ws-tickets: invalid scope "${scope}"`);
	if (ttlMs < 1_000 || ttlMs > 30 * 60_000) throw new Error('ws-tickets: ttlMs must be in [1000, 1800000]');
	ensureReaper();
	const token = crypto.randomBytes(32).toString('base64url');
	const expiresAt = Date.now() + ttlMs;
	tickets.set(token, { scope, payload, expiresAt });
	return { token, expiresAt: new Date(expiresAt).toISOString(), scope, payload };
}

/**
 * Atomically lookup + delete. Returns the payload if the ticket is
 * still valid AND its scope matches. Returns null otherwise (single
 * negative path so the caller can't distinguish wrong-scope from
 * expired from never-existed).
 */
export function consumeTicket<TPayload>(token: string, expectedScope: string): TPayload | null {
	if (typeof token !== 'string' || !token) return null;
	if (!SCOPE_RE.test(expectedScope)) return null;
	const t = tickets.get(token);
	if (!t) return null;
	tickets.delete(token);
	if (t.scope !== expectedScope) return null;
	if (t.expiresAt <= Date.now()) return null;
	return t.payload as TPayload;
}

export function _resetTicketsForTests(): void {
	tickets.clear();
	if (reaperHandle) { clearInterval(reaperHandle); reaperHandle = null; }
}

export function _ticketCountForTests(): number {
	return tickets.size;
}
