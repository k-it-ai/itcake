import { registerTool, getRegisteredToolNames } from '../tool-registry.js';
import { buildPlan, getActivePlan, setActivePlan, abortPlan } from '../plan-mode.js';
import { awaitApproval } from '../approval-map.js';
import type { SsePayload } from '../session-context.js';
import { getSessionEmitter } from '../session-context.js';

const PLAN_APPROVAL_TIMEOUT_MS = 10 * 60_000;

export interface ProposeStepInput {
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

const PLAN_REFUSED_DISPATCH_ACTIONS = new Set<string>(['filesystem_cleanup']);

export function validatePlanStep(step: ProposeStepInput): { ok: true } | { ok: false; error: string } {
	const inp = (step.input ?? {}) as Record<string, unknown>;
	if (step.toolName === 'verify_backup_integrity' || step.toolName === 'run_backup_test_restore') {
		if (typeof inp.filename !== 'string' || !inp.filename) {
			return { ok: false, error: `${step.toolName} step must specify filename — operators need to see the concrete backup the plan will act on` };
		}
	}
	if (step.toolName === 'dispatch_agent_command') {
		if (typeof inp.agentId !== 'string' || !inp.agentId) {
			return { ok: false, error: 'dispatch_agent_command step must specify agentId' };
		}
		const action = inp.action;
		if (typeof action !== 'string' || !action) {
			return { ok: false, error: 'dispatch_agent_command step must specify action — operators need to see the concrete action to approve' };
		}
		if (PLAN_REFUSED_DISPATCH_ACTIONS.has(action)) {
			return { ok: false, error: `dispatch_agent_command(${action}) cannot be planned from the AI surface; the operator must run it from the dashboard so the per-call MFA step-up is enforced` };
		}
		const payload = (inp.payload && typeof inp.payload === 'object') ? inp.payload as Record<string, unknown> : null;
		const requireString = (key: string) => {
			if (!payload || typeof payload[key] !== 'string' || !payload[key]) {
				return `dispatch_agent_command(${action}) step must specify payload.${key} — without it the matcher cannot bind auto-approval to a concrete value`;
			}
			return null;
		};
		switch (action) {
			case 'shell': {
				const err = requireString('command');
				if (err) return { ok: false, error: err };
				break;
			}
			case 'script': {
				const hasId = payload && typeof payload.scriptId === 'string' && payload.scriptId;
				const hasContent = payload && typeof payload.scriptContent === 'string' && payload.scriptContent;
				if (!hasId && !hasContent) {
					return { ok: false, error: 'dispatch_agent_command(script) step must specify payload.scriptId or payload.scriptContent' };
				}
				break;
			}
			case 'package_install':
			case 'package_uninstall':
			case 'package_update':
			case 'package_upgrade': {
				const err = requireString('package');
				if (err) return { ok: false, error: err };
				break;
			}
			case 'service_action': {
				const e1 = requireString('service');
				if (e1) return { ok: false, error: e1 };
				const e2 = requireString('action');
				if (e2) return { ok: false, error: e2 };
				break;
			}
			case 'reboot': {
				if (!payload || typeof payload.delaySeconds !== 'number') {
					return { ok: false, error: 'dispatch_agent_command(reboot) step must specify payload.delaySeconds (a concrete delay so the operator can approve a known reboot timing)' };
				}
				if (typeof payload.message !== 'string') {
					return { ok: false, error: 'dispatch_agent_command(reboot) step must specify payload.message as a string (use "" for no broadcast); the operator approves the literal text shown to end-users' };
				}
				break;
			}
		}
	}
	return { ok: true };
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
			const step: ProposeStepInput = {
				toolName: raw.toolName,
				input: (raw.input ?? {}) as Record<string, unknown>,
				rationale: raw.rationale.slice(0, 500)
			};
			const v = validatePlanStep(step);
			if (!v.ok) return v;
			cleanSteps.push(step);
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
