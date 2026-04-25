<script lang="ts">
	import { onMount } from 'svelte';
	import { t } from '$lib/i18n/index.svelte.js';
	import { api } from '$lib/api.js';
	import Card from '$components/ui/Card.svelte';

	interface AgentEvent {
		id: string;
		level: 'critical' | 'error' | 'warning';
		source: string;
		message: string;
		occurredAt: string;
		receivedAt: string;
	}

	interface Props { agentId: string; }
	let { agentId }: Props = $props();

	let events = $state<AgentEvent[]>([]);
	let levelFilter = $state<'' | AgentEvent['level']>('');
	let loading = $state(false);

	async function load() {
		loading = true;
		try {
			events = await api.get(`/api/agents/${agentId}/events?limit=200`);
		} finally {
			loading = false;
		}
	}
	onMount(load);

	const filtered = $derived(
		levelFilter ? events.filter(e => e.level === levelFilter) : events
	);

	const levelStyle: Record<AgentEvent['level'], string> = {
		critical: 'bg-red-500/15 text-red-700 dark:text-red-300',
		error: 'bg-red-500/10 text-red-700 dark:text-red-300',
		warning: 'bg-amber-500/10 text-amber-700 dark:text-amber-300'
	};

	function fmt(iso: string): string {
		try {
			return new Date(iso).toLocaleString('de-DE', { hour12: false });
		} catch {
			return iso;
		}
	}
</script>

<Card class="space-y-4">
	<div class="flex items-center justify-between">
		<div>
			<h3 class="text-lg font-semibold">{t('agents.events')}</h3>
			<p class="text-xs text-near-black/60 mt-1">{t('agents.eventsHelp')}</p>
		</div>
		<select bind:value={levelFilter} class="rounded-lg border border-border bg-bg-card px-3 py-1.5 text-sm">
			<option value="">{t('agents.eventsAllLevels')}</option>
			<option value="critical">Critical</option>
			<option value="error">Error</option>
			<option value="warning">Warning</option>
		</select>
	</div>

	{#if loading}
		<p class="text-sm text-near-black/60">{t('toast.loading')}</p>
	{:else if filtered.length === 0}
		<p class="text-sm text-near-black/60">{t('agents.eventsEmpty')}</p>
	{:else}
		<div class="space-y-2 max-h-[600px] overflow-y-auto">
			{#each filtered as e (e.id)}
				<div class="rounded border border-border p-3 text-sm">
					<div class="flex items-center justify-between gap-2 mb-1">
						<span class="px-2 py-0.5 rounded text-xs font-medium {levelStyle[e.level]}">
							{e.level}
						</span>
						<span class="text-xs text-near-black/60">{fmt(e.occurredAt)}</span>
					</div>
					{#if e.source}
						<div class="text-xs text-near-black/70 mb-1"><code>{e.source}</code></div>
					{/if}
					<div class="font-mono text-xs whitespace-pre-wrap break-words">{e.message}</div>
				</div>
			{/each}
		</div>
	{/if}
</Card>
