<script lang="ts">
	import { invalidateAll } from '$app/navigation';
	import { t } from '$lib/i18n/index.svelte.js';
	import { toast } from '$components/ui/Toast.svelte';
	import Button from '$components/ui/Button.svelte';
	import type { AgentCommand } from '$lib/types.js';

	interface Props {
		agentId: string;
		commands: AgentCommand[];
		disabled?: boolean;
	}

	let { agentId, commands, disabled = false }: Props = $props();

	let commandInput = $state('');
	let sending = $state(false);
	let expandedIds = $state(new Set<string>());

	const statusColors: Record<string, string> = {
		pending: 'bg-yellow-400',
		running: 'bg-cyan',
		completed: 'bg-green-500',
		failed: 'bg-red-500',
		cancelled: 'bg-near-black/30',
		expired: 'bg-near-black/30'
	};

	const statusTextColors: Record<string, string> = {
		pending: 'text-yellow-600 dark:text-yellow-400',
		running: 'text-cyan',
		completed: 'text-green-600 dark:text-green-400',
		failed: 'text-red-600 dark:text-red-400',
		cancelled: 'text-near-black/40',
		expired: 'text-near-black/40'
	};

	function toggle(id: string) {
		const next = new Set(expandedIds);
		if (next.has(id)) next.delete(id);
		else next.add(id);
		expandedIds = next;
	}

	const hasPendingDuplicate = $derived.by(() => {
		const trimmed = commandInput.trim().toLowerCase();
		if (!trimmed) return false;
		return commands.some(c =>
			(c.status === 'pending' || c.status === 'running') &&
			(c.payload.command as string)?.toLowerCase() === trimmed
		);
	});

	async function runCommand() {
		if (!commandInput.trim() || sending || disabled || hasPendingDuplicate) return;
		sending = true;
		try {
			const res = await fetch(`/api/agents/${agentId}/commands`, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({
					type: 'shell',
					payload: { command: commandInput.trim() }
				})
			});
			if (!res.ok) {
				toast(await res.text(), 'error');
				return;
			}
			commandInput = '';
			invalidateAll();
		} finally {
			sending = false;
		}
	}

	function handleKeydown(e: KeyboardEvent) {
		if (e.key === 'Enter' && !e.shiftKey) {
			e.preventDefault();
			runCommand();
		}
	}

	function hasOutput(cmd: AgentCommand): boolean {
		return !!(cmd.stdout || cmd.stderr);
	}
</script>

<div class="space-y-3">
	<!-- Command input -->
	<div class="flex gap-2">
		<input
			type="text"
			bind:value={commandInput}
			onkeydown={handleKeydown}
			placeholder={t('agents.shellPlaceholder')}
			{disabled}
			class="flex-1 rounded-lg border border-border bg-bg-card px-3 py-2 text-sm font-mono text-near-black placeholder:text-near-black/40 focus:outline-none focus:ring-2 focus:ring-cyan disabled:opacity-50"
		/>
		<Button size="sm" onclick={runCommand} disabled={!commandInput.trim() || sending || disabled || hasPendingDuplicate} loading={sending}>
			{t('agents.runShell')}
		</Button>
	</div>
	{#if hasPendingDuplicate}
		<p class="text-xs text-amber-600 dark:text-amber-400">{t('agents.commandAlreadyPending')}</p>
	{/if}

	<!-- Command history (matches TicketCard pattern) -->
	<div class="space-y-2">
		{#each commands as cmd (cmd.id)}
			{@const expanded = expandedIds.has(cmd.id)}
			<div class="rounded-lg border border-border bg-bg-card">
				<!-- Header row — clickable to toggle -->
				<div
					class="flex items-center gap-3 px-4 py-3 cursor-pointer hover:bg-bg/50 transition-colors"
					onclick={() => toggle(cmd.id)}
					role="button"
					tabindex="0"
					aria-expanded={expanded}
					onkeydown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggle(cmd.id); } }}
				>
					<!-- Status dot -->
					<span class="h-3 w-3 rounded-full shrink-0 {statusColors[cmd.status] ?? 'bg-near-black/30'}"></span>

					<!-- Command text -->
					<div class="flex-1 min-w-0">
						<code class="font-mono text-sm text-near-black truncate block">{cmd.payload.command ?? cmd.type}</code>
					</div>

					<!-- Exit code + status -->
					<div class="flex items-center gap-2 shrink-0">
						{#if cmd.exitCode !== null && cmd.exitCode !== 0}
							<span class="font-mono text-xs text-red-500">{cmd.exitCode}</span>
						{/if}
						<span class="text-xs font-medium {statusTextColors[cmd.status]}">
							{t(`agents.command${cmd.status.charAt(0).toUpperCase() + cmd.status.slice(1)}`)}
						</span>
						<!-- Chevron -->
						{#if hasOutput(cmd)}
							<svg class="h-4 w-4 text-near-black/30 transition-transform {expanded ? 'rotate-90' : ''}" fill="currentColor" viewBox="0 0 20 20">
								<path d="M6 6l8 4-8 4V6z" />
							</svg>
						{/if}
					</div>
				</div>

				<!-- Expanded output -->
				{#if expanded && hasOutput(cmd)}
					<div class="border-t border-border px-4 py-3 space-y-2">
						{#if cmd.stdout}
							<pre class="rounded bg-near-black/5 p-3 text-xs font-mono text-near-black overflow-x-auto max-h-64 overflow-y-auto whitespace-pre-wrap">{cmd.stdout}</pre>
						{/if}
						{#if cmd.stderr}
							<pre class="rounded bg-red-500/5 p-3 text-xs font-mono text-red-600 dark:text-red-400 overflow-x-auto max-h-48 overflow-y-auto whitespace-pre-wrap">{cmd.stderr}</pre>
						{/if}
					</div>
				{/if}
			</div>
		{:else}
			<p class="text-sm text-near-black/60 text-center py-4">{t('agents.noOutput')}</p>
		{/each}
	</div>
</div>
