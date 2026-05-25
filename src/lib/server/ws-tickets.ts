import crypto from 'node:crypto';

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

export function issueTicket<TPayload extends object>(scope: string, payload: TPayload, ttlMs: number = 30_000): WsTicket<TPayload> {
	if (!SCOPE_RE.test(scope)) throw new Error(`ws-tickets: invalid scope "${scope}"`);
	if (ttlMs < 1_000 || ttlMs > 30 * 60_000) throw new Error('ws-tickets: ttlMs must be in [1000, 1800000]');
	ensureReaper();
	const token = crypto.randomBytes(32).toString('base64url');
	const expiresAt = Date.now() + ttlMs;
	tickets.set(token, { scope, payload, expiresAt });
	return { token, expiresAt: new Date(expiresAt).toISOString(), scope, payload };
}

// Single null path — caller can't distinguish wrong-scope from expired from never-existed.
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
