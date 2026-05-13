import { json, error } from '@sveltejs/kit';
import type { RequestHandler } from './$types.js';
import { handleActionPost } from '$lib/server/request-utils.js';
import { getSession, getToolExecution, approveToolExecution } from '$services/ai-session.js';
import { resolveApproval } from '$lib/server/ai/approval-map.js';
import { getActivePlan, approvePlan, rejectPlan, type PlanStep } from '$lib/server/ai/plan-mode.js';
import { getRegisteredToolNames } from '$lib/server/ai/tool-registry.js';
import { validatePlanStep } from '$lib/server/ai/tools/plan.js';
import { recordChange } from '$lib/server/changes.js';

const MAX_PLAN_STEPS = 25;
const MAX_RATIONALE = 500;

function sanitizeEditedSteps(value: unknown): PlanStep[] | null {
	if (!Array.isArray(value)) return null;
	if (value.length === 0 || value.length > MAX_PLAN_STEPS) return null;
	const known = new Set(getRegisteredToolNames());
	const out: PlanStep[] = [];
	for (let i = 0; i < value.length; i++) {
		const raw = value[i];
		if (!raw || typeof raw !== 'object') return null;
		const r = raw as Record<string, unknown>;
		if (typeof r.toolName !== 'string' || !known.has(r.toolName)) return null;
		if (r.toolName === 'propose_action_plan') return null;
		const input = (r.input && typeof r.input === 'object' && !Array.isArray(r.input)) ? r.input as Record<string, unknown> : {};
		const rationale = typeof r.rationale === 'string' ? r.rationale.slice(0, MAX_RATIONALE) : '';
		const v = validatePlanStep({ toolName: r.toolName, input, rationale });
		if (!v.ok) return null;
		out.push({ index: i, toolName: r.toolName, input, rationale });
	}
	return out;
}

export const POST: RequestHandler = ({ request, params, locals }) =>
	handleActionPost(request, locals, {
		create: () => { throw error(400, 'Invalid action'); },
		actions: {
			decide: async (data, userId) => {
				const sessionId = String(params.id);
				const s = getSession(sessionId);
				if (!s || s.userId !== userId) throw error(404, 'session not found');
				const executionId = typeof data.executionId === 'string' ? data.executionId : '';
				const decision = data.decision === 'approved' || data.decision === 'rejected' ? data.decision : null;
				if (!executionId || !decision) throw error(400, 'executionId and decision required');

				const plan = getActivePlan(sessionId);
				if (plan && plan.id === executionId) {
					if (plan.state !== 'proposed') throw error(409, `plan is ${plan.state}`);
					if (decision === 'approved') {
						const editedSteps = data.editedSteps !== undefined
							? sanitizeEditedSteps(data.editedSteps)
							: undefined;
						if (data.editedSteps !== undefined && editedSteps === null) {
							throw error(400, 'editedSteps invalid');
						}
						const next = approvePlan(sessionId, userId, editedSteps ?? undefined);
						if (!next) throw error(409, 'plan no longer approvable');
						// Audit-chain completeness: when the operator edits the plan
						// before approving, the actual auto-executed steps can differ
						// from what the model proposed. Without recording the diff,
						// a post-hoc reviewer reading `/api/changes` can't tell
						// whether the operator approved the model's plan or a
						// substantially different one. Bounded payload size — at
						// most 25 steps × ~500-char rationale ≈ a few KB.
						const auditDiff: Record<string, { old: unknown; new: unknown }> = {
							status: { old: 'proposed', new: 'approved' },
							stepCount: { old: plan.steps.length, new: next.steps.length }
						};
						if (editedSteps !== undefined) {
							auditDiff.steps = { old: plan.steps, new: next.steps };
						}
						recordChange('ai_tool_execution', plan.id, 'update', auditDiff, userId);
						resolveApproval(plan.id, 'approved');
						return json({ ok: true, decision, planId: plan.id, stepCount: next.steps.length });
					}
					const next = rejectPlan(sessionId, userId);
					if (!next) throw error(409, 'plan no longer rejectable');
					recordChange('ai_tool_execution', plan.id, 'update', {
						status: { old: 'proposed', new: 'rejected' }
					}, userId);
					resolveApproval(plan.id, 'rejected');
					return json({ ok: true, decision, planId: plan.id });
				}

				const exec = getToolExecution(executionId);
				if (!exec || exec.sessionId !== sessionId) throw error(404, 'execution not found');
				if (exec.status !== 'pending') throw error(409, `execution is ${exec.status}`);

				if (!approveToolExecution(executionId, decision, userId)) {
					throw error(409, 'execution already resolved');
				}
				resolveApproval(executionId, decision);
				return json({ ok: true, decision });
			}
		}
	});
