<script lang="ts">
	/**
	 * AI chat slide-over. Mounts in the app layout; toggled from the TopBar.
	 *
	 * Streams replies via SSE from POST /api/ai/sessions/:id/messages and
	 * surfaces approval cards inline. Approvals POST to
	 * /api/ai/sessions/:id/approvals.
	 *
	 * Single-user app — one active session at a time, persisted via
	 * localStorage so a refresh doesn't lose the chat.
	 */
	import Btn from '$lib/components/ui/Btn.svelte';
	import Tag from '$lib/components/ui/Tag.svelte';
	import { t } from '$lib/i18n/index.svelte.js';

	interface Props {
		open: boolean;
		onclose: () => void;
		pageContext?: Record<string, unknown>;
	}
	let { open, onclose, pageContext }: Props = $props();

	type ChatMessage = {
		role: 'user' | 'assistant' | 'system';
		text: string;
		toolCalls?: Array<{ executionId: string; toolName: string; tier: number; description: string; requiresApproval: boolean; resolved?: 'approved' | 'rejected' | 'auto' }>;
	};

	type PlanProposal = {
		planId: string;
		steps: Array<{ index: number; toolName: string; input: Record<string, unknown>; rationale: string }>;
		state: 'proposed' | 'approved' | 'rejected' | 'completed' | 'aborted';
		currentStepIndex?: number;
	};

	let sessionId = $state<string | null>(null);
	let messages = $state<ChatMessage[]>([]);
	let activePlan = $state<PlanProposal | null>(null);
	let input = $state('');
	let busy = $state(false);
	let error = $state<string | null>(null);
	let listEl: HTMLDivElement | null = $state(null);

	async function startSession() {
		error = null;
		const res = await fetch('/api/ai/sessions', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ title: 'Chat', pageContext })
		});
		if (!res.ok) {
			error = (await res.text()) || 'failed to start session';
			return;
		}
		const data = await res.json();
		sessionId = data.id;
		try { localStorage.setItem('ai.sessionId', data.id); } catch { /* private mode */ }
		messages = [];
	}

	async function loadExisting() {
		const saved = (() => { try { return localStorage.getItem('ai.sessionId'); } catch { return null; } })();
		if (!saved) return;
		const res = await fetch(`/api/ai/sessions/${saved}`);
		if (!res.ok) {
			try { localStorage.removeItem('ai.sessionId'); } catch { /* noop */ }
			return;
		}
		const data = await res.json();
		if (data.session.status !== 'active') {
			try { localStorage.removeItem('ai.sessionId'); } catch { /* noop */ }
			return;
		}
		sessionId = data.session.id;
		messages = data.transcript
			.filter((m: { role: string }) => m.role === 'user' || m.role === 'assistant')
			.map((m: { role: string; contentBlocks: unknown[] }) => ({
				role: m.role as 'user' | 'assistant',
				text: blocksToText(m.contentBlocks)
			}));
	}

	function blocksToText(blocks: unknown[]): string {
		const out: string[] = [];
		for (const b of blocks) {
			if (b && typeof b === 'object' && 'type' in b) {
				const block = b as { type: string; text?: string };
				if (block.type === 'text' && typeof block.text === 'string') out.push(block.text);
			}
		}
		return out.join('');
	}

	async function send() {
		const text = input.trim();
		if (!text || busy) return;
		if (!sessionId) await startSession();
		if (!sessionId) return;
		input = '';
		messages = [...messages, { role: 'user', text }, { role: 'assistant', text: '', toolCalls: [] }];
		busy = true;
		try {
			const res = await fetch(`/api/ai/sessions/${sessionId}/messages`, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ text })
			});
			if (!res.ok || !res.body) {
				error = `chat failed: ${res.status}`;
				return;
			}
			const reader = res.body.getReader();
			const decoder = new TextDecoder();
			let buf = '';
			while (true) {
				const { done, value } = await reader.read();
				if (done) break;
				buf += decoder.decode(value, { stream: true });
				const events = buf.split('\n\n');
				buf = events.pop() ?? '';
				for (const ev of events) {
					if (!ev.startsWith('data:')) continue;
					try {
						const data = JSON.parse(ev.slice(5).trim());
						handleEvent(data);
					} catch { /* drop malformed chunk */ }
				}
			}
		} catch (e) {
			error = e instanceof Error ? e.message : String(e);
		} finally {
			busy = false;
		}
	}

	function handleEvent(ev: { type: string; [k: string]: unknown }) {
		const last = messages[messages.length - 1];
		switch (ev.type) {
			case 'text_delta':
				if (last && last.role === 'assistant') {
					last.text += String(ev.delta ?? '');
					messages = [...messages.slice(0, -1), last];
				}
				break;
			case 'tool_use':
				if (last && last.role === 'assistant') {
					last.toolCalls = [...(last.toolCalls ?? []), {
						executionId: String(ev.executionId),
						toolName: String(ev.toolName),
						tier: Number(ev.tier),
						description: String(ev.description ?? ''),
						requiresApproval: Boolean(ev.requiresApproval)
					}];
					messages = [...messages.slice(0, -1), last];
				}
				break;
			case 'tool_result': {
				if (last && last.role === 'assistant') {
					const calls = last.toolCalls ?? [];
					const idx = calls.findIndex(c => c.executionId === ev.executionId);
					if (idx >= 0 && !calls[idx].resolved) {
						calls[idx].resolved = ev.ok ? 'auto' : 'rejected';
						last.toolCalls = [...calls];
						messages = [...messages.slice(0, -1), last];
					}
				}
				break;
			}
			case 'plan_proposed':
				activePlan = {
					planId: String(ev.planId),
					steps: Array.isArray(ev.steps) ? ev.steps as PlanProposal['steps'] : [],
					state: 'proposed'
				};
				break;
			case 'plan_approved':
				if (activePlan) activePlan = { ...activePlan, state: 'approved' };
				break;
			case 'plan_rejected':
			case 'plan_aborted':
				activePlan = null;
				break;
			case 'plan_step_auto':
				if (activePlan) activePlan = { ...activePlan, currentStepIndex: Number(ev.stepIndex ?? activePlan.currentStepIndex ?? 0) + 1 };
				break;
			case 'plan_completed':
				if (activePlan) activePlan = { ...activePlan, state: 'completed' };
				break;
			case 'plan_deviation':
				// nothing to render — deviation just means the next call falls back to per-step approval
				break;
			case 'error':
				error = String(ev.error ?? 'AI error');
				break;
		}
		queueScroll();
	}

	async function decidePlan(decision: 'approved' | 'rejected') {
		if (!sessionId || !activePlan) return;
		const res = await fetch(`/api/ai/sessions/${sessionId}/approvals`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ action: 'decide', executionId: activePlan.planId, decision })
		});
		if (!res.ok) error = `plan decision failed: ${res.status}`;
	}

	async function decide(executionId: string, decision: 'approved' | 'rejected') {
		if (!sessionId) return;
		const res = await fetch(`/api/ai/sessions/${sessionId}/approvals`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ action: 'decide', executionId, decision })
		});
		if (!res.ok) error = `decision failed: ${res.status}`;
		else {
			for (const m of messages) {
				const c = m.toolCalls?.find(c => c.executionId === executionId);
				if (c) c.resolved = decision;
			}
			messages = [...messages];
		}
	}

	function queueScroll() {
		queueMicrotask(() => { if (listEl) listEl.scrollTop = listEl.scrollHeight; });
	}

	$effect(() => { if (open && !sessionId) loadExisting(); });
</script>

{#if open}
	<div class="fixed inset-0 z-40 flex justify-end" role="dialog" aria-modal="true">
		<button type="button" class="absolute inset-0 bg-black/30 cursor-default" aria-label={t('action.close')} onclick={onclose}></button>
		<div class="relative w-full max-w-md h-full bg-bg-card border-l border-border flex flex-col">
			<div class="px-4 py-3 border-b border-border flex items-center justify-between">
				<h2 class="font-semibold">{t('ai.title')}</h2>
				<button class="text-near-black/60 hover:text-near-black" onclick={onclose} aria-label={t('action.close')}>×</button>
			</div>

			<div class="flex-1 overflow-y-auto p-4 space-y-4" bind:this={listEl}>
				{#if messages.length === 0}
					<div class="text-sm text-near-black/60 space-y-2">
						<p>{t('ai.intro')}</p>
						<p class="text-xs">{t('ai.tierBlurb')}</p>
					</div>
				{/if}
				{#each messages as m, idx (idx)}
					<div class={m.role === 'user' ? 'text-right' : ''}>
						<div class={'inline-block max-w-[90%] rounded-lg px-3 py-2 text-sm whitespace-pre-wrap ' + (m.role === 'user' ? 'bg-cyan text-white' : 'bg-bg border border-border')}>
							{m.text || (m.role === 'assistant' && busy ? '…' : '')}
						</div>
						{#if m.toolCalls && m.toolCalls.length > 0}
							<div class="mt-2 space-y-2">
								{#each m.toolCalls as call (call.executionId)}
									<div class="text-left rounded-md border border-border bg-bg p-3 text-sm space-y-2">
										<div class="flex items-center justify-between gap-2">
											<span class="font-mono text-xs">{call.toolName}</span>
											<Tag tone={call.tier === 1 ? 'good' : call.tier === 2 ? 'warn' : 'bad'}>{t('ai.tier', { N: call.tier })}</Tag>
										</div>
										<p class="text-near-black/70 text-xs">{call.description}</p>
										{#if call.requiresApproval && !call.resolved}
											<div class="flex gap-2">
												<Btn size="sm" variant="primary" onclick={() => decide(call.executionId, 'approved')}>{t('ai.approve')}</Btn>
												<Btn size="sm" variant="ghost" onclick={() => decide(call.executionId, 'rejected')}>{t('ai.reject')}</Btn>
											</div>
										{:else if call.resolved}
											<p class="text-xs text-near-black/60">{call.resolved === 'approved' ? t('ai.approved') : call.resolved === 'rejected' ? t('ai.rejected') : t('ai.executed')}</p>
										{/if}
									</div>
								{/each}
							</div>
						{/if}
					</div>
				{/each}
			</div>

			{#if activePlan && activePlan.state === 'proposed'}
				<div class="border-t border-border bg-yellow-50 p-3 space-y-3">
					<div class="flex items-center justify-between">
						<div>
							<p class="font-semibold text-sm">{t('ai.planProposed', { N: activePlan.steps.length })}</p>
							<p class="text-xs text-near-black/60">{t('ai.planAutoBlurb')}</p>
						</div>
					</div>
					<ol class="space-y-2">
						{#each activePlan.steps as step (step.index)}
							<li class="flex gap-2 text-xs">
								<span class="font-mono text-near-black/40 mt-0.5">{step.index + 1}.</span>
								<div class="flex-1">
									<span class="font-mono text-near-black">{step.toolName}</span>
									{#if Object.keys(step.input).length > 0}
										<span class="text-near-black/60"> — {JSON.stringify(step.input).slice(0, 120)}</span>
									{/if}
									<p class="text-near-black/70 mt-0.5">{step.rationale}</p>
								</div>
							</li>
						{/each}
					</ol>
					<div class="flex gap-2">
						<Btn size="sm" variant="primary" onclick={() => decidePlan('approved')}>{t('ai.approvePlan')}</Btn>
						<Btn size="sm" variant="ghost" onclick={() => decidePlan('rejected')}>{t('ai.reject')}</Btn>
					</div>
				</div>
			{:else if activePlan && activePlan.state === 'approved'}
				<div class="border-t border-border bg-green-50 px-4 py-2 text-xs flex items-center justify-between">
					<span>{t('ai.planExecuting', { N: (activePlan.currentStepIndex ?? 0) + 1, M: activePlan.steps.length })}</span>
				</div>
			{/if}

			{#if error}
				<div class="px-4 py-2 bg-red-50 text-red-700 text-sm">{error}</div>
			{/if}

			<form class="border-t border-border p-3 flex gap-2" onsubmit={(e) => { e.preventDefault(); send(); }}>
				<input
					type="text"
					bind:value={input}
					placeholder={t('ai.placeholder')}
					disabled={busy}
					class="flex-1 px-3 py-2 rounded-md border border-border bg-bg-card text-sm focus:outline-none focus:ring-2 focus:ring-cyan"
				/>
				<Btn type="submit" size="md" disabled={busy || !input.trim()}>{busy ? '…' : t('ai.send')}</Btn>
			</form>
		</div>
	</div>
{/if}
