import Anthropic from '@anthropic-ai/sdk';
import type { MessageParam, ContentBlockParam, TextBlock, ToolUseBlock } from '@anthropic-ai/sdk/resources/index.js';
import { db, generateId, getSetting } from '$lib/server/db.js';
import { recordChange } from '$lib/server/changes.js';
import { events } from '$lib/server/events.js';
import { sanitizeUserText, sanitizePageContext } from '$lib/server/ai/sanitizer.js';
import { checkGuardrails } from '$lib/server/ai/guardrails.js';
import { compactToolResultForChat, redactSensitiveInput } from '$lib/server/ai/compaction.js';
import { recordUsage, claimTurnSlotIfWithinBudget, monthToDateCostCents } from '$lib/server/ai/cost-tracker.js';
import { awaitApproval, rejectPendingForSession } from '$lib/server/ai/approval-map.js';
import { buildSystemPrompt } from '$lib/server/ai/system-prompt.js';
import { getTool, getToolDefinitionsForMode } from '$lib/server/ai/tool-registry.js';
import '$lib/server/ai/tools/index.js';
import { bindSessionEmitter } from '$lib/server/ai/session-context.js';
import type { SsePayload } from '$lib/server/ai/session-context.js';
import { getActivePlan, matchPlanStep, advancePlan, clearActivePlan } from '$lib/server/ai/plan-mode.js';
import { pinnedFetch } from '$lib/server/pinned-https.js';
import type { AiSettings, ApprovalMode, AiToolExecution, AiToolExecutionStatus } from '$lib/server/ai/types.js';

interface SessionRow {
	id: string;
	user_id: string;
	title: string;
	model: string;
	approval_mode: string;
	page_context: string;
	status: string;
	total_input_tokens: number;
	total_output_tokens: number;
	total_cache_read_tokens: number;
	total_cost_cents: number;
	turn_count: number;
	plan_steps: string | null;
	created_at: string;
	updated_at: string;
}

const stmtInsertSession = db.prepare(
	`INSERT INTO ai_sessions (id, user_id, title, model, approval_mode, page_context) VALUES (?, ?, ?, ?, ?, ?)`
);
const stmtGetSession = db.prepare(
	`SELECT id, user_id, title, model, approval_mode, page_context, status,
	        total_input_tokens, total_output_tokens, total_cache_read_tokens,
	        total_cost_cents, turn_count, plan_steps, created_at, updated_at
	 FROM ai_sessions WHERE id = ?`
);
const stmtListSessions = db.prepare(
	`SELECT id, user_id, title, model, approval_mode, page_context, status,
	        total_input_tokens, total_output_tokens, total_cache_read_tokens,
	        total_cost_cents, turn_count, plan_steps, created_at, updated_at
	 FROM ai_sessions WHERE user_id = ? ORDER BY updated_at DESC LIMIT ?`
);
const stmtCloseSession = db.prepare("UPDATE ai_sessions SET status = 'closed', updated_at = datetime('now') WHERE id = ?");
const stmtBumpUsage = db.prepare(
	`UPDATE ai_sessions SET
	   total_input_tokens = total_input_tokens + ?,
	   total_output_tokens = total_output_tokens + ?,
	   total_cache_read_tokens = total_cache_read_tokens + ?,
	   total_cost_cents = total_cost_cents + ?,
	   updated_at = datetime('now')
	 WHERE id = ?`
);
const stmtFlagSession = db.prepare("UPDATE ai_sessions SET status = 'flagged', updated_at = datetime('now') WHERE id = ?");

const stmtInsertMessage = db.prepare(
	`INSERT INTO ai_messages (id, session_id, role, content_blocks, tool_use_id, tool_name, input_tokens, output_tokens, cache_read_tokens) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
);
const stmtListMessages = db.prepare(
	`SELECT id, session_id, role, content_blocks, tool_use_id, tool_name, input_tokens, output_tokens, cache_read_tokens, created_at
	 FROM ai_messages WHERE session_id = ? ORDER BY created_at ASC, id ASC`
);

const stmtInsertToolExec = db.prepare(
	`INSERT INTO ai_tool_executions (id, session_id, message_id, tool_name, tool_input, tier, status, approval_description) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
);
const stmtUpdateToolExec = db.prepare(
	`UPDATE ai_tool_executions SET status = ?, result_summary = ?, duration_ms = ?, error_message = ?, completed_at = datetime('now') WHERE id = ?`
);
const stmtApproveToolExec = db.prepare(
	`UPDATE ai_tool_executions SET status = ?, approved_by = ?, approved_at = datetime('now') WHERE id = ?`
);
const stmtGetToolExec = db.prepare(
	`SELECT id, session_id, message_id, tool_name, tool_input, tier, status, approval_description, approved_by, approved_at,
	        result_summary, duration_ms, error_message, created_at, completed_at
	 FROM ai_tool_executions WHERE id = ?`
);

export interface AiSession {
	id: string;
	userId: string;
	title: string;
	model: string;
	approvalMode: ApprovalMode;
	pageContext: Record<string, unknown>;
	status: 'active' | 'closed' | 'flagged' | 'expired';
	totalInputTokens: number;
	totalOutputTokens: number;
	totalCacheReadTokens: number;
	totalCostCents: number;
	turnCount: number;
	createdAt: string;
	updatedAt: string;
}

function rowToSession(r: SessionRow): AiSession {
	let pageContext: Record<string, unknown> = {};
	try { pageContext = JSON.parse(r.page_context); } catch { /* keep default */ }
	return {
		id: r.id, userId: r.user_id, title: r.title, model: r.model,
		approvalMode: r.approval_mode as ApprovalMode,
		pageContext,
		status: r.status as AiSession['status'],
		totalInputTokens: r.total_input_tokens,
		totalOutputTokens: r.total_output_tokens,
		totalCacheReadTokens: r.total_cache_read_tokens,
		totalCostCents: r.total_cost_cents,
		turnCount: r.turn_count,
		createdAt: r.created_at,
		updatedAt: r.updated_at
	};
}

export class AiNotConfiguredError extends Error {
	constructor() { super('AI brain is not enabled or no API key is configured'); this.name = 'AiNotConfiguredError'; }
}
export class AiBudgetExceededError extends Error {
	constructor(public monthCents: number, public limitCents: number) {
		super(`AI monthly budget exceeded: $${(monthCents / 100).toFixed(2)} of $${(limitCents / 100).toFixed(2)}`);
		this.name = 'AiBudgetExceededError';
	}
}

export function startSession(userId: string, input: { title?: string; pageContext?: Record<string, unknown>; approvalMode?: ApprovalMode }): AiSession {
	const settings = getSetting<AiSettings>('ai');
	if (!settings?.enabled || !settings.apiKey) throw new AiNotConfiguredError();
	const id = generateId();
	const title = (input.title ?? 'New chat').slice(0, 200);
	const ctx = sanitizePageContext(input.pageContext);
	const approval = input.approvalMode ?? settings.approvalMode ?? 'per_step';
	db.transaction(() => {
		stmtInsertSession.run(id, userId, title, settings.model, approval, JSON.stringify(ctx));
		recordChange('ai_session', id, 'create', { title: { old: null, new: title } }, userId);
	})();
	const row = stmtGetSession.get(id) as SessionRow;
	return rowToSession(row);
}

export function getSession(id: string): AiSession | null {
	const row = stmtGetSession.get(id) as SessionRow | undefined;
	return row ? rowToSession(row) : null;
}

export function listSessions(userId: string, limit = 50): AiSession[] {
	const rows = stmtListSessions.all(userId, Math.min(200, Math.max(1, limit))) as SessionRow[];
	return rows.map(rowToSession);
}

export function closeSession(id: string, userId: string): boolean {
	const session = getSession(id);
	if (!session) return false;
	// Drain any pending approvals for this session BEFORE flipping status —
	// `awaitApproval` resolvers held in the in-memory map would otherwise
	// hang for up to 5 min (10 for plans) until the reaper sweep, even
	// though the operator UI is gone. Resolving as 'rejected' wakes the
	// awaiter in the tool-execution loop, which records `failed`.
	rejectPendingForSession(id);
	clearActivePlan(id);
	stmtCloseSession.run(id);
	recordChange('ai_session', id, 'update', { status: { old: session.status, new: 'closed' } }, userId);
	return true;
}

interface MessageRow {
	id: string;
	session_id: string;
	role: string;
	content_blocks: string;
	tool_use_id: string | null;
	tool_name: string | null;
	input_tokens: number | null;
	output_tokens: number | null;
	cache_read_tokens: number | null;
	created_at: string;
}

function loadAnthropicMessages(sessionId: string): MessageParam[] {
	const rows = stmtListMessages.all(sessionId) as MessageRow[];
	const messages: MessageParam[] = [];
	for (const r of rows) {
		if (r.role !== 'user' && r.role !== 'assistant') continue;
		try {
			const blocks = JSON.parse(r.content_blocks) as ContentBlockParam[];
			messages.push({ role: r.role, content: blocks });
		} catch {
			// Skip malformed; the session can still recover from later messages.
		}
	}
	return messages;
}

function persistMessage(sessionId: string, role: 'user' | 'assistant', blocks: ContentBlockParam[], usage?: { input?: number; output?: number; cacheRead?: number }): string {
	const id = generateId();
	stmtInsertMessage.run(
		id, sessionId, role, JSON.stringify(blocks), null, null,
		usage?.input ?? null, usage?.output ?? null, usage?.cacheRead ?? null
	);
	return id;
}

function rowToToolExec(r: {
	id: string; session_id: string; message_id: string | null; tool_name: string;
	tool_input: string; tier: number; status: string; approval_description: string | null;
	approved_by: string | null; approved_at: string | null; result_summary: string | null;
	duration_ms: number | null; error_message: string | null; created_at: string; completed_at: string | null;
}): AiToolExecution {
	let toolInput: Record<string, unknown> = {};
	try { toolInput = JSON.parse(r.tool_input); } catch { /* keep default */ }
	return {
		id: r.id, sessionId: r.session_id, messageId: r.message_id,
		toolName: r.tool_name, toolInput,
		tier: r.tier as 1 | 2 | 3 | 4,
		status: r.status as AiToolExecutionStatus,
		approvalDescription: r.approval_description,
		approvedBy: r.approved_by, approvedAt: r.approved_at,
		resultSummary: r.result_summary, durationMs: r.duration_ms,
		errorMessage: r.error_message,
		createdAt: r.created_at, completedAt: r.completed_at
	};
}

export function getToolExecution(id: string): AiToolExecution | null {
	const row = stmtGetToolExec.get(id) as Parameters<typeof rowToToolExec>[0] | undefined;
	return row ? rowToToolExec(row) : null;
}

export function approveToolExecution(executionId: string, decision: 'approved' | 'rejected', userId: string): boolean {
	const existing = getToolExecution(executionId);
	if (!existing || existing.status !== 'pending') return false;
	stmtApproveToolExec.run(decision, userId, executionId);
	recordChange('ai_tool_execution', executionId, 'update', {
		status: { old: 'pending', new: decision }
	}, userId);
	return true;
}

export interface PostMessageInput {
	sessionId: string;
	userId: string;
	text: string;
	emitSse?: (payload: SsePayload) => void;
}

// Pin the outbound Anthropic API connection through `resolveTarget` so a
// resolver poisoning of `api.anthropic.com` can't redirect the API key + tool
// transcript to a private LAN host. The Anthropic SDK exposes `fetch` (custom
// implementation) but not `httpAgent`, so we route via `pinnedFetch()` which
// resolves the host per-request via `resolveTarget` and streams the response
// body via a `ReadableStream` so `messages.stream` deltas flow through
// chunk-by-chunk. Matches the SMTP / S3 / WebDAV / RDAP / HTTP / SSL / ping
// invariant in CLAUDE.md §Security-model-invariants.
const ANTHROPIC_TIMEOUT_MS = 120_000;
const anthropicFetch = pinnedFetch();

function buildClient(apiKey: string): Anthropic {
	return new Anthropic({
		apiKey,
		baseURL: 'https://api.anthropic.com',
		fetch: anthropicFetch,
		timeout: ANTHROPIC_TIMEOUT_MS,
		maxRetries: 0
	});
}

const MAX_TOOL_LOOP_ITERATIONS = 10;

export async function postMessage(input: PostMessageInput): Promise<AiSession> {
	const settings = getSetting<AiSettings>('ai');
	if (!settings?.enabled || !settings.apiKey) throw new AiNotConfiguredError();
	const session = getSession(input.sessionId);
	if (!session) throw new Error('session not found');
	if (session.userId !== input.userId) throw new Error('forbidden');
	if (session.status !== 'active') throw new Error(`session is ${session.status}`);

	const turnCap = (typeof settings.maxTurnsPerSession === 'number' && settings.maxTurnsPerSession > 0)
		? settings.maxTurnsPerSession : null;

	const sanitized = sanitizeUserText(input.text);
	if (sanitized.rejected) {
		input.emitSse?.({ type: 'error', sessionId: session.id, error: sanitized.rejectReason ?? 'rejected' });
		throw new Error(sanitized.rejectReason ?? 'input rejected');
	}

	const budget = claimTurnSlotIfWithinBudget({ sessionId: session.id, turnCap });
	if (budget.atTurnCap) {
		input.emitSse?.({ type: 'error', sessionId: session.id, error: 'turn limit reached' });
		throw new Error(`turn limit reached (${turnCap})`);
	}
	if (!budget.withinBudget) {
		input.emitSse?.({ type: 'error', sessionId: session.id, error: 'monthly budget exceeded' });
		throw new AiBudgetExceededError(budget.monthCents, budget.limitCents);
	}

	const releaseEmitter = bindSessionEmitter(session.id, input.emitSse);
	try {

	const messages = loadAnthropicMessages(input.sessionId);
	messages.push({ role: 'user', content: [{ type: 'text', text: sanitized.clean }] });
	persistMessage(session.id, 'user', [{ type: 'text', text: sanitized.clean }]);

	const client = buildClient(settings.apiKey);
	const systemPrompt = buildSystemPrompt({
		approvalMode: session.approvalMode,
		consultantMode: !!settings.consultantMode,
		pageContext: session.pageContext,
		monthlyBudgetCents: budget.limitCents,
		monthSpendCents: monthToDateCostCents()
	});

	let totalUsage = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0 };

	// Record usage in a finally so a mid-stream throw (Anthropic 5xx, rate
	// limit, abrupt disconnect, any tool-handler exception that escapes the
	// per-tool catch above) still bills the tokens we DID consume. Otherwise
	// `claimTurnSlotIfWithinBudget` advanced `turn_count` at the entry, but
	// the cost rollup was never written — sessions could ramp `turn_count`
	// without recording cents, deflating month-to-date below the real spend.
	try {
	for (let iteration = 0; iteration < MAX_TOOL_LOOP_ITERATIONS; iteration++) {
		const stream = client.messages.stream({
			model: settings.model,
			max_tokens: settings.maxOutputTokensPerTurn,
			system: [
				{ type: 'text', text: systemPrompt, cache_control: { type: 'ephemeral' } }
			],
			tools: getToolDefinitionsForMode({ consultantMode: !!settings.consultantMode }),
			messages,
			...(settings.thinkingMode === 'adaptive' ? { thinking: { type: 'adaptive' as const } } : {})
		});

		stream.on('text', delta => {
			input.emitSse?.({ type: 'text_delta', sessionId: session.id, delta });
		});

		const message = await stream.finalMessage();

		const u = message.usage;
		totalUsage = {
			inputTokens: totalUsage.inputTokens + (u.input_tokens ?? 0),
			outputTokens: totalUsage.outputTokens + (u.output_tokens ?? 0),
			cacheReadTokens: totalUsage.cacheReadTokens + (u.cache_read_input_tokens ?? 0)
		};

		messages.push({ role: 'assistant', content: message.content as ContentBlockParam[] });
		persistMessage(session.id, 'assistant', message.content as ContentBlockParam[], {
			input: u.input_tokens ?? undefined,
			output: u.output_tokens ?? undefined,
			cacheRead: u.cache_read_input_tokens ?? undefined
		});

		if (message.stop_reason !== 'tool_use') break;

		const toolUses = message.content.filter((b): b is ToolUseBlock => b.type === 'tool_use');
		const toolResults: Array<{ type: 'tool_result'; tool_use_id: string; content: string; is_error?: boolean }> = [];

		for (const tu of toolUses) {
			const guard = checkGuardrails(tu.name, tu.input, session.approvalMode, { consultantMode: !!settings.consultantMode });
			const execId = generateId();

			let planMatch: ReturnType<typeof matchPlanStep> | null = null;
			if (
				session.approvalMode === 'plan' &&
				tu.name !== 'propose_action_plan' &&
				guard.allowed
			) {
				const plan = getActivePlan(session.id);
				if (plan && (plan.state === 'approved' || plan.state === 'executing')) {
					const callInput = (tu.input && typeof tu.input === 'object') ? tu.input as Record<string, unknown> : {};
					planMatch = matchPlanStep(plan, tu.name, callInput);
				}
			}

			const planAutoApproved = !!planMatch && planMatch.matched && guard.requiresApproval;
			const redactedInput = redactSensitiveInput(tu.input ?? {});

			stmtInsertToolExec.run(
				execId, session.id, null, tu.name, JSON.stringify(redactedInput),
				guard.tier,
				!guard.allowed ? 'failed' :
				guard.tier === 1 ? 'auto' :
				planAutoApproved ? 'auto' :
				guard.requiresApproval ? 'pending' : 'auto',
				guard.description
			);
			input.emitSse?.({
				type: 'tool_use', sessionId: session.id,
				executionId: execId, toolName: tu.name, tier: guard.tier,
				description: guard.description,
				requiresApproval: guard.requiresApproval && !planAutoApproved
			});

			if (!guard.allowed) {
				stmtUpdateToolExec.run('failed', null, 0, guard.reason, execId);
				toolResults.push({ type: 'tool_result', tool_use_id: tu.id, content: `tool blocked: ${guard.reason}`, is_error: true });
				continue;
			}

			if (planMatch && !planMatch.matched && guard.requiresApproval) {
				input.emitSse?.({
					type: 'plan_deviation', sessionId: session.id,
					executionId: execId, toolName: tu.name,
					reason: planMatch.reason
				});
			}

			if (planAutoApproved && planMatch && planMatch.stepIndex != null) {
				input.emitSse?.({
					type: 'plan_step_auto', sessionId: session.id,
					executionId: execId, toolName: tu.name,
					stepIndex: planMatch.stepIndex
				});
			}

			if (guard.requiresApproval && !planAutoApproved) {
				input.emitSse?.({
					type: 'approval_required', sessionId: session.id,
					executionId: execId, toolName: tu.name, tier: guard.tier,
					description: guard.description, input: redactedInput
				});
				const decision = await awaitApproval(execId, session.id);
				if (decision === 'rejected') {
					stmtUpdateToolExec.run('rejected', null, 0, null, execId);
					toolResults.push({ type: 'tool_result', tool_use_id: tu.id, content: 'operator declined this action', is_error: true });
					continue;
				}
			}

			const tool = getTool(tu.name);
			if (!tool) {
				stmtUpdateToolExec.run('failed', null, 0, 'tool not registered', execId);
				toolResults.push({ type: 'tool_result', tool_use_id: tu.id, content: `tool ${tu.name} is not registered`, is_error: true });
				continue;
			}

			const t0 = Date.now();
			try {
				// Pass the REDACTED input to the handler — the operator approved
				// the redacted view (line 354/395), and the audit row stored the
				// redacted view, so the handler must operate on the same value
				// the operator saw. If the model proposed a tool call containing
				// a literal secret (e.g. an AWS key smuggled in via prompt
				// injection), this makes the dispatch fail safely on the redacted
				// placeholder rather than silently executing the un-redacted
				// version that no one — operator OR auditor — ever saw.
				const result = await tool.handler(redactedInput as Record<string, unknown>, { userId: input.userId, sessionId: session.id });
				const compacted = compactToolResultForChat(result);
				stmtUpdateToolExec.run('completed', `${compacted.bytes} bytes (${compacted.pass} pass)`, Date.now() - t0, null, execId);
				toolResults.push({ type: 'tool_result', tool_use_id: tu.id, content: compacted.json });
				input.emitSse?.({ type: 'tool_result', sessionId: session.id, executionId: execId, ok: true, bytes: compacted.bytes });

				if (planMatch && planMatch.matched && planMatch.stepIndex != null) {
					const advanced = advancePlan(session.id, planMatch.stepIndex);
					if (advanced && advanced.state === 'completed') {
						input.emitSse?.({
							type: 'plan_completed', sessionId: session.id, planId: advanced.id
						});
					}
				}
			} catch (e) {
				// Internal-only: full message goes to server log + audit row so the
				// operator can debug. SSE + tool-result (which is re-ingested by
				// the model) get a generic trace-id message — Anthropic SDK
				// stack-frames, filesystem ENOENT paths, sqlite constraint
				// messages, etc. otherwise leak to a SessionOnly attacker reading
				// the SSE stream and re-flow back into the model context.
				const msg = e instanceof Error ? e.message : String(e);
				const traceId = crypto.randomUUID();
				console.error(`[ai-tool-exec ${traceId}] tool ${tu.name} threw:`, e);
				stmtUpdateToolExec.run('failed', null, Date.now() - t0, msg, execId);
				const safe = `tool ${tu.name} failed (trace: ${traceId})`;
				toolResults.push({ type: 'tool_result', tool_use_id: tu.id, content: safe, is_error: true });
				input.emitSse?.({ type: 'tool_result', sessionId: session.id, executionId: execId, ok: false, error: safe });
			}
		}

		messages.push({ role: 'user', content: toolResults });
		persistMessage(session.id, 'user', toolResults);
	}
	} finally {
		// Always-runs cost recording. The success path falls through here
		// before emitting `done`; the failure path goes through this on the
		// way to re-throwing.
		const cost = recordUsage({ model: settings.model, usage: totalUsage });
		stmtBumpUsage.run(totalUsage.inputTokens, totalUsage.outputTokens, totalUsage.cacheReadTokens, cost.costCents, session.id);

		if (totalUsage.outputTokens === 0 && totalUsage.inputTokens === 0) {
			stmtFlagSession.run(session.id);
		}

		events.emit('ai_session_turn', {
			sessionId: session.id,
			costCents: cost.costCents,
			input: totalUsage.inputTokens,
			output: totalUsage.outputTokens
		});
	}

	input.emitSse?.({ type: 'done', sessionId: session.id });

	return getSession(session.id)!;
	} finally {
		releaseEmitter();
	}
}

export interface SessionTranscriptEntry {
	id: string;
	role: 'user' | 'assistant' | 'tool_use' | 'tool_result' | 'system_event';
	contentBlocks: unknown[];
	createdAt: string;
}

export function getSessionTranscript(sessionId: string): SessionTranscriptEntry[] {
	const rows = stmtListMessages.all(sessionId) as MessageRow[];
	return rows.map(r => {
		let blocks: unknown[] = [];
		try { blocks = JSON.parse(r.content_blocks); } catch { /* keep default */ }
		return {
			id: r.id, role: r.role as SessionTranscriptEntry['role'],
			contentBlocks: blocks, createdAt: r.created_at
		};
	});
}
