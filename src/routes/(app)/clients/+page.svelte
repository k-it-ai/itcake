<script lang="ts">
	import { goto } from '$app/navigation';
	import TopBar from '$components/layout/TopBar.svelte';
	import Button from '$components/ui/Button.svelte';
	import Card from '$components/ui/Card.svelte';
	import DataTable from '$components/ui/DataTable.svelte';
	import SearchInput from '$components/ui/SearchInput.svelte';
	import EmptyState from '$components/ui/EmptyState.svelte';
	import { formatMoney } from '$lib/money.js';
	import { t } from '$lib/i18n/index.svelte.js';
	import type { Client } from '$lib/types.js';
	import type { PageData } from './$types.js';

	let { data }: { data: PageData } = $props();

	let searchTimer: ReturnType<typeof setTimeout> | undefined;

	function updateFilters(updates: Record<string, string>) {
		const url = new URL(window.location.href);
		for (const [key, value] of Object.entries(updates)) {
			if (value) url.searchParams.set(key, value);
			else url.searchParams.delete(key);
		}
		url.searchParams.delete('page');
		goto(url.pathname + url.search, { replaceState: true, keepFocus: true });
	}

	function debouncedSearch(value: string) {
		clearTimeout(searchTimer);
		searchTimer = setTimeout(() => updateFilters({ q: value }), 300);
	}

	function handlePageChange(newPage: number) {
		const url = new URL(window.location.href);
		if (newPage > 1) url.searchParams.set('page', String(newPage));
		else url.searchParams.delete('page');
		goto(url.pathname + url.search, { replaceState: true });
	}

	let columns = $derived([
		{ key: 'clientNumber', label: t('label.id'), sortable: true },
		{ key: 'name', label: t('client.name'), sortable: true },
		{ key: 'email', label: t('client.email'), sortable: true },
		{ key: 'phone', label: t('client.phone') },
		{ key: 'address', label: t('settings.city'), sortable: true },
		{ key: 'paid', label: t('dashboard.revenue'), sortable: true, sortValue: (c: Client) => data.revenueMap[c.id]?.paid ?? 0, class: 'text-right' },
		{ key: 'outstanding', label: t('dashboard.outstanding'), sortable: true, sortValue: (c: Client) => data.revenueMap[c.id]?.outstanding ?? 0, class: 'text-right' },
	]);

	let hasFilters = $derived(data.filters.search !== '');
</script>

<svelte:head><title>{t('client.titlePlural')} | ITCake</title></svelte:head>

<TopBar title={t('client.titlePlural')}>
	{#snippet children()}
		<Button size="sm" onclick={() => goto('/clients/new')}>+ {t('client.new')}</Button>
	{/snippet}
</TopBar>

<div class="p-6">
	{#if data.total === 0 && !hasFilters}
		<Card>
			<EmptyState title={t('client.noClients')} description={t('empty.createFirstClient')}>
				{#snippet children()}
					<Button size="sm" onclick={() => goto('/clients/new')}>+ {t('client.new')}</Button>
				{/snippet}
			</EmptyState>
		</Card>
	{:else}
		<Card flush>
			<div class="flex flex-col gap-3 p-3 border-b border-border sm:flex-row sm:flex-wrap sm:items-center sm:p-4">
				<SearchInput value={data.filters.search} oninput={(e: Event) => debouncedSearch((e.currentTarget as HTMLInputElement).value)} placeholder={t('search.placeholder')} class="flex-1 sm:max-w-[200px]" />
			</div>
			<DataTable
				{columns}
				data={data.clients}
				total={data.total}
				currentPage={data.page}
				pageSize={data.pageSize}
				onpagechange={handlePageChange}
				onrowclick={(client) => goto(`/clients/${client.id}`)}
			>
				{#snippet row(client: Client)}
					{@const rev = data.revenueMap[client.id]}
					<td class="px-4 py-3 text-near-black/60 text-xs tabular-nums">{client.clientNumber || '\u2014'}</td>
					<td class="px-4 py-3 font-medium text-near-black">{client.name}</td>
					<td class="px-4 py-3 text-near-black/70">{client.email}</td>
					<td class="px-4 py-3 text-near-black/70">{client.phone}</td>
					<td class="px-4 py-3 text-near-black/70">{client.address?.city || ''}</td>
					<td class="px-4 py-3 text-right tabular-nums text-near-black/70">{rev?.paid ? formatMoney(rev.paid, data.currency) : '\u2014'}</td>
					<td class="px-4 py-3 text-right tabular-nums {rev?.outstanding ? 'text-red font-medium' : 'text-near-black/70'}">{rev?.outstanding ? formatMoney(rev.outstanding, data.currency) : '\u2014'}</td>
				{/snippet}
			</DataTable>
		</Card>
	{/if}
</div>
