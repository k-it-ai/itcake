/**
 * In-memory approval gate for Tier 3 tool calls.
 *
 * The aiToolExecutions row is the audit trail; this Map is the
 * synchronisation primitive. Single-process Node + single-user means
 * we don't need Redis or DB-poll — when the model proposes a Tier 3
 * tool call, we register a Promise + resolver here, send the operator
 * an SSE event with the executionId, and `await` the resolver. The
 * approval API route flips the row to approved/rejected and calls
 * resolveApproval() to wake the awaiter.
 *
 * Reaper sweeps every 30s for entries past their expiry.
 */

interface PendingApproval {
	executionId: string;
	sessionId: string;
	resolve: (decision: 'approved' | 'rejected') => void;
	expiresAt: number;
}

const pending = new Map<string, PendingApproval>();
const REAPER_INTERVAL_MS = 30_000;
const DEFAULT_TIMEOUT_MS = 5 * 60_000;

let reaperHandle: ReturnType<typeof setInterval> | null = null;
function ensureReaper(): void {
	if (reaperHandle) return;
	reaperHandle = setInterval(() => {
		const now = Date.now();
		for (const [id, p] of pending) {
			if (p.expiresAt <= now) {
				pending.delete(id);
				p.resolve('rejected');
			}
		}
	}, REAPER_INTERVAL_MS);
	if (typeof reaperHandle === 'object' && reaperHandle && 'unref' in reaperHandle) {
		(reaperHandle as { unref?: () => void }).unref?.();
	}
}

export function awaitApproval(executionId: string, sessionId: string, timeoutMs = DEFAULT_TIMEOUT_MS): Promise<'approved' | 'rejected'> {
	ensureReaper();
	return new Promise(resolve => {
		const expiresAt = Date.now() + timeoutMs;
		pending.set(executionId, { executionId, sessionId, resolve, expiresAt });
	});
}

export function resolveApproval(executionId: string, decision: 'approved' | 'rejected'): boolean {
	const p = pending.get(executionId);
	if (!p) return false;
	pending.delete(executionId);
	p.resolve(decision);
	return true;
}

export function pendingCountForSession(sessionId: string): number {
	let n = 0;
	for (const p of pending.values()) if (p.sessionId === sessionId) n++;
	return n;
}

export function _resetApprovalMapForTests(): void {
	for (const p of pending.values()) p.resolve('rejected');
	pending.clear();
	if (reaperHandle) { clearInterval(reaperHandle); reaperHandle = null; }
}

export function _approvalCountForTests(): number {
	return pending.size;
}
