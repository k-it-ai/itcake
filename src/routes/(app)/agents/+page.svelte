<script lang="ts">
	import { invalidateAll } from '$app/navigation';
	import { page } from '$app/state';
	import { t } from '#lib/i18n/index.svelte.js';
	import TopBar from '#lib/components/shell/TopBar.svelte';
	import Btn from '#lib/components/ui/Btn.svelte';
	import Card from '#lib/components/ui/Card.svelte';
	import Dot from '#lib/components/ui/Dot.svelte';
	import EmptyState from '#lib/components/ui/EmptyState.svelte';
	import SearchInput from '#components/ui/SearchInput.svelte';
	import AgentCard from '#components/agents/AgentCard.svelte';
	import EnrollmentDialog from '#components/agents/EnrollmentDialog.svelte';
	import type { PageData } from './$types.js';

	let { data }: { data: PageData } = $props();

	let search = $state('');
	let enrollOpen = $state(page.url.searchParams.get('new') === '1');

	const filtered = $derived.by(() => {
		if (!search) return data.agents;
		const q = search.toLowerCase();
		return data.agents.filter(a =>
			a.name.toLowerCase().includes(q) ||
			a.hostname.toLowerCase().includes(q) ||
			a.os.toLowerCase().includes(q)
		);
	});

	const sub = $derived(`${data.summary.total} enrolled`);

	$effect(() => {
		const es = new EventSource('/api/agents/events');
		es.onmessage = (e) => {
			if (e.data === 'update') invalidateAll();
		};
		return () => es.close();
	});
</script>

<svelte:head><title>{t('agents.title')} | ITCake</title></svelte:head>

<TopBar title={t('agents.title')} breadcrumb={['Operations', 'Agents']} {sub}>
	{#snippet right()}
		<Btn variant="ghost" size="sm" href="/api/exports?kind=agents">Export CSV</Btn>
		<Btn variant="primary" size="sm" onclick={() => enrollOpen = true}>+ {t('agents.new')}</Btn>
	{/snippet}
</TopBar>

<div class="p-5 space-y-5">
	{#if data.agents.length > 0}
		<div class="grid grid-cols-2 gap-3 sm:grid-cols-4">
			<Card>
				<div class="flex items-center gap-2 mb-1">
					<Dot tone="good" />
					<span class="text-[11px]" style="color:var(--muted)">{t('agents.agentsOnline')}</span>
				</div>
				<div class="text-[22px] font-semibold leading-tight num" style="color:var(--ink)">{data.summary.online}</div>
			</Card>
			<Card>
				<div class="flex items-center gap-2 mb-1">
					<Dot tone="warn" />
					<span class="text-[11px]" style="color:var(--muted)">{t('agents.agentsStale')}</span>
				</div>
				<div class="text-[22px] font-semibold leading-tight num" style="color:var(--ink)">{data.summary.stale}</div>
			</Card>
			<Card>
				<div class="flex items-center gap-2 mb-1">
					<Dot tone="bad" />
					<span class="text-[11px]" style="color:var(--muted)">{t('agents.agentsOffline')}</span>
				</div>
				<div class="text-[22px] font-semibold leading-tight num" style="color:var(--ink)">{data.summary.offline}</div>
			</Card>
			<Card>
				<div class="flex items-center gap-2 mb-1">
					<Dot tone="mute" />
					<span class="text-[11px]" style="color:var(--muted)">{t('agents.agentsTotal')}</span>
				</div>
				<div class="text-[22px] font-semibold leading-tight num" style="color:var(--ink)">{data.summary.total}</div>
			</Card>
		</div>

		<SearchInput bind:value={search} />

		{#if filtered.length > 0}
			<div class="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
				{#each filtered as agent (agent.id)}
					<AgentCard {agent} latestMetric={data.latestMetrics[agent.id] ?? null} />
				{/each}
			</div>
		{:else}
			<p class="text-[12px] text-center py-8" style="color:var(--muted)">{t('action.search')} — 0 results</p>
		{/if}
	{:else}
		<Card>
			<EmptyState title={t('agents.noAgents')} description={t('agents.noAgentsDescription')}>
				{#snippet actions()}
					<Btn variant="primary" size="sm" onclick={() => enrollOpen = true}>+ {t('agents.new')}</Btn>
				{/snippet}
			</EmptyState>
		</Card>
	{/if}
</div>

<EnrollmentDialog bind:open={enrollOpen} onclose={() => { enrollOpen = false; invalidateAll(); }} />
