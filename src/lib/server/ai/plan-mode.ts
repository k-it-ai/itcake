import { db, generateId } from '$lib/server/db.js';

export interface PlanStep {
	index: number;
	toolName: string;
	input: Record<string, unknown>;
	rationale: string;
}

export type PlanState = 'proposed' | 'approved' | 'rejected' | 'executing' | 'completed' | 'aborted';

export interface ActionPlan {
	id: string;
	sessionId: string;
	steps: PlanStep[];
	state: PlanState;
	approvedBy: string | null;
	approvedAt: string | null;
	currentStepIndex: number;
	createdAt: string;
}

export interface PlanMatchResult {
	matched: boolean;
	stepIndex: number | null;
	reason: string;
}

const KEY_FIELDS = [
	'agentId', 'action',
	'scriptId', 'policyId', 'monitorId',
	'ticketId', 'invoiceId', 'clientId',
	'filename'
] as const;

const cache = new Map<string, ActionPlan>();

const stmtSelectPlan = db.prepare('SELECT plan_steps FROM ai_sessions WHERE id = ?');
const stmtUpdatePlan = db.prepare(
	"UPDATE ai_sessions SET plan_steps = ?, updated_at = datetime('now') WHERE id = ?"
);

function readFromDb(sessionId: string): ActionPlan | null {
	const row = stmtSelectPlan.get(sessionId) as { plan_steps: string | null } | undefined;
	if (!row || !row.plan_steps) return null;
	try {
		const parsed = JSON.parse(row.plan_steps) as ActionPlan;
		if (!parsed || typeof parsed !== 'object' || !Array.isArray(parsed.steps)) return null;
		return parsed;
	} catch {
		return null;
	}
}

function writeToDb(sessionId: string, plan: ActionPlan | null): void {
	stmtUpdatePlan.run(plan ? JSON.stringify(plan) : null, sessionId);
}

export function setActivePlan(sessionId: string, plan: ActionPlan): void {
	cache.set(sessionId, plan);
	writeToDb(sessionId, plan);
}

export function getActivePlan(sessionId: string): ActionPlan | null {
	const cached = cache.get(sessionId);
	if (cached) return cached;
	const fromDb = readFromDb(sessionId);
	if (fromDb) cache.set(sessionId, fromDb);
	return fromDb;
}

export function clearActivePlan(sessionId: string): void {
	cache.delete(sessionId);
	writeToDb(sessionId, null);
}

export function approvePlan(sessionId: string, userId: string, replacementSteps?: PlanStep[]): ActionPlan | null {
	const plan = getActivePlan(sessionId);
	if (!plan || plan.state !== 'proposed') return null;
	const next: ActionPlan = {
		...plan,
		steps: replacementSteps ?? plan.steps,
		state: 'approved',
		approvedBy: userId,
		approvedAt: new Date().toISOString(),
		currentStepIndex: 0
	};
	setActivePlan(sessionId, next);
	return next;
}

export function rejectPlan(sessionId: string, userId: string): ActionPlan | null {
	const plan = getActivePlan(sessionId);
	if (!plan || plan.state !== 'proposed') return null;
	const next: ActionPlan = {
		...plan,
		state: 'rejected',
		approvedBy: userId,
		approvedAt: new Date().toISOString()
	};
	setActivePlan(sessionId, next);
	return next;
}

export function advancePlan(sessionId: string, stepIndex: number): ActionPlan | null {
	const plan = getActivePlan(sessionId);
	if (!plan) return null;
	const nextIndex = stepIndex + 1;
	const reachedEnd = nextIndex >= plan.steps.length;
	const next: ActionPlan = {
		...plan,
		state: reachedEnd ? 'completed' : 'executing',
		currentStepIndex: nextIndex
	};
	setActivePlan(sessionId, next);
	return next;
}

export function abortPlan(sessionId: string, _reason: string): ActionPlan | null {
	const plan = getActivePlan(sessionId);
	if (!plan) return null;
	const next: ActionPlan = { ...plan, state: 'aborted' };
	setActivePlan(sessionId, next);
	return next;
}

export function buildPlan(sessionId: string, steps: Array<{ toolName: string; input: Record<string, unknown>; rationale: string }>): ActionPlan {
	const indexed: PlanStep[] = steps.map((s, i) => ({
		index: i,
		toolName: s.toolName,
		input: s.input ?? {},
		rationale: s.rationale ?? ''
	}));
	return {
		id: generateId(),
		sessionId,
		steps: indexed,
		state: 'proposed',
		approvedBy: null,
		approvedAt: null,
		currentStepIndex: -1,
		createdAt: new Date().toISOString()
	};
}

// Map every action the `dispatch_agent_command` tool accepts (see
// `DISPATCH_AGENT_COMMAND_ACTIONS` in guardrails.ts) to the payload keys
// that must match between the approved plan step and the auto-executed
// call. Empty array = no payload to pin (the action takes only
// `agentId + action`); the entry is still required so a missing key
// can't silently auto-approve under "unknown action, no mismatch".
const DISPATCH_PINNED_KEYS_BY_ACTION: Record<string, readonly string[]> = {
	shell: ['command'],
	script: ['scriptId', 'scriptContent', 'scriptName'],
	package_install: ['package'],
	package_uninstall: ['package'],
	package_update: ['package'],
	package_upgrade: ['package'],
	service_action: ['service', 'action'],
	reboot: ['delaySeconds', 'message'],
	filesystem_cleanup: ['category', 'paths'],
	os_update: [],
	software_update: [],
	system_info_refresh: [],
	check_os_updates: [],
	boot_performance_collect: [],
	hardware_warranty_collect: [],
	cis_audit: []
};

function payloadMismatchForDispatchCommand(plan: PlanStep, call: Record<string, unknown>): string | null {
	if (plan.toolName !== 'dispatch_agent_command') return null;
	const planPayload = (plan.input.payload && typeof plan.input.payload === 'object') ? plan.input.payload as Record<string, unknown> : null;
	const callPayload = (call.payload && typeof call.payload === 'object') ? call.payload as Record<string, unknown> : null;
	const planAction = typeof plan.input.action === 'string' ? plan.input.action : null;
	if (!planAction) return 'plan step has no action';
	// Fail-closed on any action that doesn't have an explicit entry in the
	// pinned-keys map. The previous behaviour was to return `null` (= "no
	// mismatch, auto-approve") on a missing key — which would let a future
	// guardrails change that adds a new dispatch action skip payload
	// pinning entirely until the map is updated. Lockstep with
	// DISPATCH_AGENT_COMMAND_ACTIONS in guardrails.ts.
	const keys = Object.prototype.hasOwnProperty.call(DISPATCH_PINNED_KEYS_BY_ACTION, planAction)
		? DISPATCH_PINNED_KEYS_BY_ACTION[planAction]
		: null;
	if (!keys) return `plan step action "${planAction}" has no pinned-keys entry — refusing auto-approval`;
	// Actions whose pinned-keys list is empty (os_update, software_update)
	// auto-approve on the agentId+action match alone — no payload to compare.
	if (keys.length === 0) return null;
	// Defense-in-depth: even though `validatePlanStep` rejects propose-time /
	// edited-step plans without payloads, fail-closed here so a future code
	// path that calls `setActivePlan` without going through the validator
	// can't bypass auto-approval. The previous behaviour was to return null
	// (= "no mismatch, auto-approve") when planPayload was missing.
	if (!planPayload) {
		return `plan step is dispatch_agent_command(${planAction}) but has no payload object`;
	}
	// Each pinned key independently: plan and call must agree (both present
	// with the same value, OR both absent). The previous behaviour was to
	// `continue` when plan had no value — letting the call add the key. For
	// `script`, validatePlanStep allows EITHER scriptId or scriptContent, so
	// one of those will be undefined on the plan side. The strict-equality
	// match here preserves that: undefined on plan + undefined on call = OK,
	// undefined on plan + value on call = mismatch (call is smuggling a
	// destructive field the operator didn't approve).
	for (const key of keys) {
		const planVal = planPayload[key];
		const callVal = callPayload?.[key];
		if (JSON.stringify(planVal) !== JSON.stringify(callVal)) {
			return `payload.${key} mismatch (plan=${JSON.stringify(planVal)}, call=${JSON.stringify(callVal)})`;
		}
	}
	return null;
}

// Cap from-approval execution window. Without it, an approved-but-
// partially-executed plan stays match-eligible across operator absences:
// the operator approves a 5-step plan, 3 steps run, the model stops, and
// the plan sits in `state: 'executing'` for hours/days. When the operator
// resumes the same session a week later, the next time the model
// constructs a matching tool call (Tier 3 `reboot`, `shell`, etc.) it
// auto-executes against an approval the operator has long forgotten.
// 10 min matches the CLAUDE.md documented "Plan timeout 10 min" and
// keeps the approve→complete window short enough that re-approval is
// the natural expectation. abortOrphanedPlans on the daily tick + at
// boot reaps stale rows; this check is the per-call gate.
export const PLAN_EXECUTION_WINDOW_MS = 10 * 60 * 1000;

export function matchPlanStep(
	plan: ActionPlan,
	toolName: string,
	input: Record<string, unknown>
): PlanMatchResult {
	if (plan.state !== 'approved' && plan.state !== 'executing') {
		return { matched: false, stepIndex: null, reason: `plan state is ${plan.state}` };
	}
	if (plan.approvedAt) {
		const ageMs = Date.now() - new Date(plan.approvedAt).getTime();
		if (Number.isFinite(ageMs) && ageMs > PLAN_EXECUTION_WINDOW_MS) {
			return { matched: false, stepIndex: null, reason: `plan execution window expired (${Math.round(ageMs / 1000)}s since approval)` };
		}
	}
	const idx = plan.currentStepIndex;
	if (idx < 0 || idx >= plan.steps.length) {
		return { matched: false, stepIndex: null, reason: 'no remaining plan steps' };
	}
	const step = plan.steps[idx];
	if (step.toolName !== toolName) {
		return { matched: false, stepIndex: idx, reason: `expected ${step.toolName}, got ${toolName}` };
	}
	for (const key of KEY_FIELDS) {
		const planVal = step.input[key];
		const callVal = input[key];
		if (planVal !== undefined) {
			if (callVal === undefined) {
				return { matched: false, stepIndex: idx, reason: `${key} omitted from call (plan pinned ${JSON.stringify(planVal)})` };
			}
			if (planVal !== callVal) {
				return { matched: false, stepIndex: idx, reason: `${key} mismatch (plan=${JSON.stringify(planVal)}, call=${JSON.stringify(callVal)})` };
			}
		}
	}
	const payloadMismatch = payloadMismatchForDispatchCommand(step, input);
	if (payloadMismatch) {
		return { matched: false, stepIndex: idx, reason: payloadMismatch };
	}
	return { matched: true, stepIndex: idx, reason: 'matches planned step' };
}

export function _resetPlanCacheForTests(): void {
	cache.clear();
}

const stmtListOrphanedPlans = db.prepare(
	"SELECT id, plan_steps FROM ai_sessions WHERE plan_steps IS NOT NULL AND (plan_steps LIKE '%\"state\":\"proposed\"%' OR plan_steps LIKE '%\"state\":\"executing\"%' OR plan_steps LIKE '%\"state\":\"approved\"%')"
);
// Age-gate so a boot-time sweep doesn't wipe a pending approval the
// operator received seconds before the restart. The 10-minute window
// matches the approval-map reaper's default timeout, so anything older
// is already considered abandoned by the in-memory gate.
const stmtExpirePendingExecutions = db.prepare(
	"UPDATE ai_tool_executions SET status = 'expired' WHERE status = 'pending' AND datetime(created_at) < datetime('now', '-10 minutes')"
);

export const abortOrphanedPlans = db.transaction((): number => {
	const rows = stmtListOrphanedPlans.all() as { id: string; plan_steps: string }[];
	let aborted = 0;
	for (const r of rows) {
		try {
			const parsed = JSON.parse(r.plan_steps) as ActionPlan;
			if (!parsed || typeof parsed !== 'object' || !Array.isArray(parsed.steps)) continue;
			if (parsed.state !== 'proposed' && parsed.state !== 'executing' && parsed.state !== 'approved') continue;
			// Stale `approved`/`executing` rows (operator approved, then the
			// session was abandoned mid-flight) must reap too — without this
			// the per-call matchPlanStep timeout is the only gate, which is
			// fine in steady state but leaves the row visible to listing.
			if (parsed.state !== 'proposed' && parsed.approvedAt) {
				const ageMs = Date.now() - new Date(parsed.approvedAt).getTime();
				if (Number.isFinite(ageMs) && ageMs <= PLAN_EXECUTION_WINDOW_MS) continue;
			}
			const next: ActionPlan = { ...parsed, state: 'aborted' };
			stmtUpdatePlan.run(JSON.stringify(next), r.id);
			aborted++;
		} catch { /* malformed JSON — leave row alone, tx parser will surface it */ }
	}
	stmtExpirePendingExecutions.run();
	return aborted;
});

abortOrphanedPlans();
