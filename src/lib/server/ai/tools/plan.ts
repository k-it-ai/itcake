import { registerTool, getRegisteredToolNames } from '../tool-registry.js';
import { buildPlan, getActivePlan, setActivePlan, abortPlan } from '../plan-mode.js';
import { awaitApproval } from '../approval-map.js';
import type { SsePayload } from '../session-context.js';
import { getSessionEmitter } from '../session-context.js';

const PLAN_APPROVAL_TIMEOUT_MS = 10 * 60_000;

interface ProposeStepInput {
	toolName: string;
	input: Record<string, unknown>;
	rationale: string;
}

function isStepInput(value: unknown): value is ProposeStepInput {
	if (!value || typeof value !== 'object') return false;
	const v = value as Record<string, unknown>;
	if (typeof v.toolName !== 'string' || !v.toolName) return false;
	if (typeof v.rationale !== 'string') return false;
	if (v.input != null && typeof v.input !== 'object') return false;
	return true;
}

registerTool('propose_action_plan', {
	definition: {
		name: 'propose_action_plan',
		description:
			'Use ONLY when the operator is in plan approval mode. Propose a multi-step plan of tool calls; the operator approves once and matching steps then execute without per-call approval (deviations from the plan still require approval). Each step is {toolName, input, rationale}. Tool names MUST match the registered tools you have available. Include the actual key fields (agentId, action, scriptId, monitorId, ticketId, invoiceId, clientId, filename, policyId) for each call so the operator sees concrete actions, not placeholders.',
		input_schema: {
			type: 'object',
			properties: {
				steps: {
					type: 'array',
					maxItems: 25,
					minItems: 1,
					items: {
						type: 'object',
						properties: {
							toolName: { type: 'string' },
							input: { type: 'object' },
							rationale: { type: 'string', maxLength: 500 }
						},
						required: ['toolName', 'input', 'rationale']
					}
				}
			},
			required: ['steps']
		}
	},
	handler: async (input, ctx) => {
		const rawSteps = Array.isArray(input.steps) ? input.steps : [];
		if (rawSteps.length === 0) {
			return { ok: false, error: 'plan must include at least one step' };
		}
		if (rawSteps.length > 25) {
			return { ok: false, error: 'plan may not exceed 25 steps' };
		}

		const known = new Set(getRegisteredToolNames());
		const cleanSteps: ProposeStepInput[] = [];
		for (const raw of rawSteps) {
			if (!isStepInput(raw)) {
				return { ok: false, error: 'each step must include toolName, input, rationale' };
			}
			if (raw.toolName === 'propose_action_plan') {
				return { ok: false, error: 'a plan cannot contain propose_action_plan' };
			}
			if (!known.has(raw.toolName)) {
				return { ok: false, error: `unknown tool in plan: ${raw.toolName}` };
			}
			// Per-tool minimum-pinned-field check. The plan-match logic is
			// permissive about fields the plan leaves undefined — fine for
			// optional refinements, but for destructive tools the pinned
			// fields MUST cover what determines the risk tier and the
			// target. Without `action` here a plan that says
			// "dispatch_agent_command on agent a-1" lets the model fire
			// any destructive action under the cover of plan-approval.
			if (raw.toolName === 'dispatch_agent_command') {
				const inp = (raw.input ?? {}) as Record<string, unknown>;
				if (typeof inp.agentId !== 'string' || !inp.agentId) {
					return { ok: false, error: 'dispatch_agent_command step must specify agentId' };
				}
				if (typeof inp.action !== 'string' || !inp.action) {
					return { ok: false, error: 'dispatch_agent_command step must specify action — operators need to see the concrete action to approve' };
				}
			}
			cleanSteps.push({
				toolName: raw.toolName,
				input: (raw.input ?? {}) as Record<string, unknown>,
				rationale: raw.rationale.slice(0, 500)
			});
		}

		const existing = getActivePlan(ctx.sessionId);
		if (existing && (existing.state === 'proposed' || existing.state === 'approved' || existing.state === 'executing')) {
			return { ok: false, error: `a plan is already ${existing.state}; ask the operator to abort it first` };
		}

		const plan = buildPlan(ctx.sessionId, cleanSteps);
		setActivePlan(ctx.sessionId, plan);

		const emit = getSessionEmitter(ctx.sessionId);
		emit?.({
			type: 'plan_proposed',
			sessionId: ctx.sessionId,
			planId: plan.id,
			steps: plan.steps
		} as SsePayload);

		const decision = await awaitApproval(plan.id, ctx.sessionId, PLAN_APPROVAL_TIMEOUT_MS);

		const refreshed = getActivePlan(ctx.sessionId);
		if (decision === 'approved' && refreshed?.state === 'approved') {
			emit?.({
				type: 'plan_approved',
				sessionId: ctx.sessionId,
				planId: plan.id,
				steps: refreshed.steps
			} as SsePayload);
			return {
				ok: true,
				planId: plan.id,
				stepCount: refreshed.steps.length,
				message: 'plan approved; execute the steps in order now'
			};
		}

		abortPlan(ctx.sessionId, decision);
		emit?.({
			type: 'plan_rejected',
			sessionId: ctx.sessionId,
			planId: plan.id
		} as SsePayload);
		return { ok: false, planId: plan.id, message: 'operator rejected the plan' };
	}
});
