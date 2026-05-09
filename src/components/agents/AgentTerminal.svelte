<script lang="ts">
	import { invalidateAll } from '$app/navigation';
	import { t } from '$lib/i18n/index.svelte.js';
	import { toast } from '$components/ui/Toast.svelte';
	import Btn from '$lib/components/ui/Btn.svelte';
	import Dot from '$lib/components/ui/Dot.svelte';
	import Tag from '$lib/components/ui/Tag.svelte';
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

	type DotTone = 'good' | 'brand' | 'warn' | 'bad' | 'mute';
	type TagTone = 'neutral' | 'brand' | 'good' | 'warn' | 'bad' | 'accent';

	const statusDotTone: Record<string, DotTone> = {
		pending: 'warn',
		running: 'brand',
		completed: 'good',
		failed: 'bad',
		cancelled: 'mute',
		expired: 'mute'
	};

	const statusTagTone: Record<string, TagTone> = {
		pending: 'warn',
		running: 'brand',
		completed: 'good',
		failed: 'bad',
		cancelled: 'neutral',
		expired: 'neutral'
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
			class="flex-1 rounded-md border px-3 py-1.5 text-[12.5px] font-mono focus:outline-2 focus:outline-[var(--brand)] focus:outline-offset-1 disabled:opacity-50"
			style="background:var(--card);border-color:var(--line);color:var(--ink)"
		/>
		<Btn variant="primary" size="sm" onclick={runCommand} disabled={!commandInput.trim() || sending || disabled || hasPendingDuplicate}>
			{t('agents.runShell')}
		</Btn>
	</div>
	{#if hasPendingDuplicate}
		<p class="text-[11.5px]" style="color:var(--warn)">{t('agents.commandAlreadyPending')}</p>
	{/if}

	<!-- Command history -->
	<div class="space-y-2">
		{#each commands as cmd (cmd.id)}
			{@const expanded = expandedIds.has(cmd.id)}
			<div class="rounded-md border" style="background:var(--card);border-color:var(--line)">
				<div
					class="flex items-center gap-3 px-3 py-2 cursor-pointer transition-colors"
					onclick={() => toggle(cmd.id)}
					role="button"
					tabindex="0"
					aria-expanded={expanded}
					onkeydown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggle(cmd.id); } }}
				>
					<Dot tone={statusDotTone[cmd.status] ?? 'mute'} />
					<div class="flex-1 min-w-0">
						<code class="font-mono text-[12px] truncate block" style="color:var(--ink)">{cmd.payload.command ?? cmd.type}</code>
					</div>
					<div class="flex items-center gap-2 shrink-0">
						{#if cmd.exitCode !== null && cmd.exitCode !== 0}
							<span class="font-mono text-[11px] num" style="color:var(--bad)">{cmd.exitCode}</span>
						{/if}
						<Tag tone={statusTagTone[cmd.status] ?? 'neutral'}>
							{t(`agents.command${cmd.status.charAt(0).toUpperCase() + cmd.status.slice(1)}`)}
						</Tag>
						{#if hasOutput(cmd)}
							<svg class="h-4 w-4 transition-transform" style="color:var(--muted);transform:rotate({expanded ? 90 : 0}deg)" fill="currentColor" viewBox="0 0 20 20">
								<path d="M6 6l8 4-8 4V6z" />
							</svg>
						{/if}
					</div>
				</div>

				{#if expanded && hasOutput(cmd)}
					<div class="border-t px-3 py-2 space-y-2" style="border-color:var(--line-2)">
						{#if cmd.stdout}
							<pre class="rounded p-2 text-[11px] font-mono overflow-x-auto max-h-64 overflow-y-auto whitespace-pre-wrap" style="background:#fbfcfd;color:var(--ink)">{cmd.stdout}</pre>
						{/if}
						{#if cmd.stderr}
							<pre class="rounded p-2 text-[11px] font-mono overflow-x-auto max-h-48 overflow-y-auto whitespace-pre-wrap" style="background:var(--bad-soft);color:#7a1a22">{cmd.stderr}</pre>
						{/if}
					</div>
				{/if}
			</div>
		{:else}
			<p class="text-[12px] text-center py-4" style="color:var(--muted)">{t('agents.noOutput')}</p>
		{/each}
	</div>
</div>
