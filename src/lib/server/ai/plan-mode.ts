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

// Per-action payload keys whose pinned values MUST match exactly. The
// approval card showed the operator the planned values; auto-approval can
// only fire if the call carries the same values. The matcher is otherwise
// permissive about plan-undefined fields so the model can refine optional
// parameters (e.g. timeoutSeconds).
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
	software_update: []
};

function payloadMismatchForDispatchCommand(plan: PlanStep, call: Record<string, unknown>): string | null {
	if (plan.toolName !== 'dispatch_agent_command') return null;
	const planPayload = (plan.input.payload && typeof plan.input.payload === 'object') ? plan.input.payload as Record<string, unknown> : null;
	const callPayload = (call.payload && typeof call.payload === 'object') ? call.payload as Record<string, unknown> : null;
	if (!planPayload) return null;
	const planAction = typeof plan.input.action === 'string' ? plan.input.action : null;
	const keys = planAction ? DISPATCH_PINNED_KEYS_BY_ACTION[planAction] : undefined;
	if (!keys) return null;
	for (const key of keys) {
		const planVal = planPayload[key];
		if (planVal === undefined) continue;
		const callVal = callPayload?.[key];
		if (JSON.stringify(planVal) !== JSON.stringify(callVal)) {
			return `payload.${key} mismatch (plan=${JSON.stringify(planVal)}, call=${JSON.stringify(callVal)})`;
		}
	}
	return null;
}

export function matchPlanStep(
	plan: ActionPlan,
	toolName: string,
	input: Record<string, unknown>
): PlanMatchResult {
	if (plan.state !== 'approved' && plan.state !== 'executing') {
		return { matched: false, stepIndex: null, reason: `plan state is ${plan.state}` };
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

// In-memory approval resolvers don't survive process restart; any plan still
// proposed/executing on disk has lost its in-flight handler so the operator
// can no longer approve or reject it. Mark them aborted at module load so a
// fresh plan can be proposed. Same logic for per-step Tier-3 approvals
// (`ai_tool_executions.status = 'pending'`) — without this sweep the
// operator's POST to /approvals would write 'approved' to the DB but the
// awaiter is gone, leaving the row stuck "approved-but-no-result".
export function abortOrphanedPlans(): number {
	const rows = db.prepare(
		"SELECT id, plan_steps FROM ai_sessions WHERE plan_steps IS NOT NULL AND (plan_steps LIKE '%\"state\":\"proposed\"%' OR plan_steps LIKE '%\"state\":\"executing\"%')"
	).all() as { id: string; plan_steps: string }[];
	let aborted = 0;
	for (const r of rows) {
		try {
			const parsed = JSON.parse(r.plan_steps) as ActionPlan;
			if (!parsed || typeof parsed !== 'object' || !Array.isArray(parsed.steps)) continue;
			if (parsed.state !== 'proposed' && parsed.state !== 'executing') continue;
			const next: ActionPlan = { ...parsed, state: 'aborted' };
			stmtUpdatePlan.run(JSON.stringify(next), r.id);
			aborted++;
		} catch { /* malformed JSON — leave row alone, tx parser will surface it */ }
	}
	db.prepare("UPDATE ai_tool_executions SET status = 'expired' WHERE status = 'pending'").run();
	return aborted;
}

abortOrphanedPlans();
