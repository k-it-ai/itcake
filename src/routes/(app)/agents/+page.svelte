<script lang="ts">
	import { invalidateAll } from '$app/navigation';
	import { page } from '$app/state';
	import { t } from '$lib/i18n/index.svelte.js';
	import TopBar from '$components/layout/TopBar.svelte';
	import Button from '$components/ui/Button.svelte';
	import Card from '$components/ui/Card.svelte';
	import SearchInput from '$components/ui/SearchInput.svelte';
	import EmptyState from '$components/ui/EmptyState.svelte';
	import AgentCard from '$components/agents/AgentCard.svelte';
	import EnrollmentDialog from '$components/agents/EnrollmentDialog.svelte';
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

	$effect(() => {
		const es = new EventSource('/api/agents/events');
		es.onmessage = (e) => {
			if (e.data === 'update') invalidateAll();
		};
		return () => es.close();
	});
</script>

<svelte:head><title>{t('agents.title')} | ITCake</title></svelte:head>

<TopBar title={t('agents.title')}>
	{#snippet children()}
		<a class="text-xs text-near-black/60 hover:text-cyan underline-offset-2 hover:underline" href="/api/exports?kind=agents" download>
			Export CSV
		</a>
		<Button size="sm" onclick={() => enrollOpen = true}>+ {t('agents.new')}</Button>
	{/snippet}
</TopBar>

<div class="p-6 space-y-6">
	{#if data.agents.length > 0}
		<!-- Summary cards -->
		<div class="grid grid-cols-2 gap-4 sm:grid-cols-4">
			<Card>
				<div class="text-center">
					<div class="text-2xl font-bold text-near-black">{data.summary.total}</div>
					<div class="text-xs text-near-black/60">{t('agents.agentsTotal')}</div>
				</div>
			</Card>
			<Card>
				<div class="text-center">
					<div class="text-2xl font-bold text-green-600 dark:text-green-400">{data.summary.online}</div>
					<div class="text-xs text-near-black/60">{t('agents.agentsOnline')}</div>
				</div>
			</Card>
			<Card>
				<div class="text-center">
					<div class="text-2xl font-bold text-red-600 dark:text-red-400">{data.summary.offline}</div>
					<div class="text-xs text-near-black/60">{t('agents.agentsOffline')}</div>
				</div>
			</Card>
			<Card>
				<div class="text-center">
					<div class="text-2xl font-bold text-orange-600 dark:text-orange-400">{data.summary.stale}</div>
					<div class="text-xs text-near-black/60">{t('agents.agentsStale')}</div>
				</div>
			</Card>
		</div>

		<!-- Search -->
		<SearchInput bind:value={search} />

		<!-- Agent list -->
		{#if filtered.length > 0}
			<div class="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
				{#each filtered as agent (agent.id)}
					<AgentCard {agent} latestMetric={data.latestMetrics[agent.id] ?? null} />
				{/each}
			</div>
		{:else}
			<p class="text-sm text-near-black/60 text-center py-8">{t('action.search')} — 0 results</p>
		{/if}
	{:else}
		<EmptyState title={t('agents.noAgents')} description={t('agents.noAgentsDescription')}>
			{#snippet icon()}
				<svg class="h-12 w-12" fill="none" stroke="currentColor" viewBox="0 0 24 24" stroke-width="1">
					<path stroke-linecap="round" stroke-linejoin="round" d="M9 3v2m6-2v2M9 19v2m6-2v2M5 9H3m2 6H3m18-6h-2m2 6h-2M7 19h10a2 2 0 002-2V7a2 2 0 00-2-2H7a2 2 0 00-2 2v10a2 2 0 002 2zM9 9h6v6H9V9z" />
				</svg>
			{/snippet}
			{#snippet children()}
				<Button size="sm" onclick={() => enrollOpen = true} class="mt-4">+ {t('agents.new')}</Button>
			{/snippet}
		</EmptyState>
	{/if}
</div>

<EnrollmentDialog bind:open={enrollOpen} onclose={() => { enrollOpen = false; invalidateAll(); }} />
