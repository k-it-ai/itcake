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

/**
 * For dispatch_agent_command, also pin the inner payload — `command` /
 * `scriptId` / `scriptContent`. CLAUDE.md's "matcher is permissive about
 * plan-undefined fields" is necessary so the model can refine numeric
 * timeouts and the like, but it cannot extend to the actual command
 * being executed: the operator approved e.g. `systemctl status nginx`,
 * not `rm -rf /`. If the plan step pinned a payload value, the call must
 * match it exactly.
 */
function payloadMismatchForDispatchCommand(plan: PlanStep, call: Record<string, unknown>): string | null {
	if (plan.toolName !== 'dispatch_agent_command') return null;
	const planPayload = (plan.input.payload && typeof plan.input.payload === 'object') ? plan.input.payload as Record<string, unknown> : null;
	const callPayload = (call.payload && typeof call.payload === 'object') ? call.payload as Record<string, unknown> : null;
	if (!planPayload) return null;
	for (const key of ['command', 'scriptId', 'scriptContent', 'scriptName'] as const) {
		const planVal = planPayload[key];
		if (planVal === undefined) continue;
		const callVal = callPayload?.[key];
		if (planVal !== callVal) {
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
		if (planVal !== undefined && callVal !== undefined && planVal !== callVal) {
			return { matched: false, stepIndex: idx, reason: `${key} mismatch (plan=${JSON.stringify(planVal)}, call=${JSON.stringify(callVal)})` };
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
