<script lang="ts">
	import { onMount } from 'svelte';
	import { t } from '$lib/i18n/index.svelte.js';
	import { api } from '$lib/api.js';
	import Card from '$lib/components/ui/Card.svelte';
	import SectionHead from '$lib/components/ui/SectionHead.svelte';
	import Tag from '$lib/components/ui/Tag.svelte';

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

	type TagTone = 'bad' | 'warn';
	const levelTone: Record<AgentEvent['level'], TagTone> = {
		critical: 'bad',
		error: 'bad',
		warning: 'warn'
	};

	function fmt(iso: string): string {
		try {
			return new Date(iso).toLocaleString('de-DE', { hour12: false });
		} catch {
			return iso;
		}
	}
</script>

<Card>
	<SectionHead title={t('agents.events')} sub={t('agents.eventsHelp')}>
		{#snippet right()}
			<select
				bind:value={levelFilter}
				class="rounded-md border px-2 py-1 text-[12px] focus:outline-2 focus:outline-[var(--brand)] focus:outline-offset-1"
				style="background:var(--card);border-color:var(--line);color:var(--ink)"
			>
				<option value="">{t('agents.eventsAllLevels')}</option>
				<option value="critical">Critical</option>
				<option value="error">Error</option>
				<option value="warning">Warning</option>
			</select>
		{/snippet}
	</SectionHead>

	{#if loading}
		<p class="text-[12px]" style="color:var(--muted)">{t('toast.loading')}</p>
	{:else if filtered.length === 0}
		<p class="text-[12px]" style="color:var(--muted)">{t('agents.eventsEmpty')}</p>
	{:else}
		<div class="space-y-2 max-h-[600px] overflow-y-auto">
			{#each filtered as e (e.id)}
				<div class="rounded-md border p-3 text-[12px]" style="border-color:var(--line)">
					<div class="flex items-center justify-between gap-2 mb-1">
						<Tag tone={levelTone[e.level]}>{e.level}</Tag>
						<span class="text-[11px] num" style="color:var(--muted)">{fmt(e.occurredAt)}</span>
					</div>
					{#if e.source}
						<div class="text-[11px] mb-1" style="color:var(--muted)"><code class="font-mono">{e.source}</code></div>
					{/if}
					<div class="font-mono text-[11px] whitespace-pre-wrap break-words" style="color:var(--ink)">{e.message}</div>
				</div>
			{/each}
		</div>
	{/if}
</Card>
