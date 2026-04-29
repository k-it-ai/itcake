<script lang="ts">
	import { goto } from '$app/navigation';
	import TopBar from '$components/layout/TopBar.svelte';
	import Button from '$components/ui/Button.svelte';
	import Card from '$components/ui/Card.svelte';
	import DataTable from '$components/ui/DataTable.svelte';
	import SearchInput from '$components/ui/SearchInput.svelte';
	import Badge from '$components/ui/Badge.svelte';
	import EmptyState from '$components/ui/EmptyState.svelte';
	import { formatMoney } from '$lib/money.js';
	import { formatDate } from '$lib/format-date.js';
	import { proposalBadgeVariant } from '$lib/select-options.js';
	import { t } from '$lib/i18n/index.svelte.js';
	import type { Proposal } from '$lib/types.js';
	import type { PageData } from './$types.js';

	let { data }: { data: PageData } = $props();

	let dateFormat = $derived(data.settings?.general?.dateFormat || 'DD/MM/YYYY');

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
		{ key: 'documentId', label: t('proposal.number'), sortable: true },
		{ key: 'buyer', label: t('invoice.client'), sortable: true },
		{ key: 'issueDate', label: t('invoice.date'), sortable: true },
		{ key: 'validUntil', label: t('proposal.validUntil'), sortable: true },
		{ key: 'total', label: t('invoice.amount'), sortable: true, class: 'text-right' },
		{ key: 'status', label: t('invoice.status') },
	]);

	let clientOptions = $derived([
		{ value: '', label: t('invoice.allClients') },
		...(data.clientNames as string[]).map((n: string) => ({ value: n, label: n }))
	]);

	let hasFilters = $derived(
		data.filters.status !== '' || data.filters.client !== '' ||
		data.filters.dateFrom !== '' || data.filters.dateTo !== '' || data.filters.search !== ''
	);

	// Determine if we have any proposals at all (vs just no matches for filters)
	let totalCount = $derived(data.total + (hasFilters ? 1 : 0)); // If filters active and total=0, there might still be proposals
</script>

<svelte:head><title>{t('proposal.titlePlural')} | ITCake</title></svelte:head>

<TopBar title={t('proposal.titlePlural')}>
	{#snippet children()}
		<Button size="sm" onclick={() => goto('/proposals/new')}>+ {t('proposal.new')}</Button>
	{/snippet}
</TopBar>

<div class="p-6">
	{#if data.total === 0 && !hasFilters}
		<Card>
			<EmptyState title={t('empty.noProposals')} description={t('empty.createFirstProposal')}>
				{#snippet children()}
					<Button size="sm" onclick={() => goto('/proposals/new')}>+ {t('proposal.new')}</Button>
				{/snippet}
			</EmptyState>
		</Card>
	{:else}
		<Card flush>
			<div class="flex flex-col gap-3 p-3 border-b border-border sm:flex-row sm:flex-wrap sm:items-center sm:p-4">
				<div class="flex items-center gap-2 w-full sm:w-auto">
					<SearchInput value={data.filters.search} oninput={(e: Event) => debouncedSearch((e.currentTarget as HTMLInputElement).value)} placeholder={t('search.placeholder')} class="flex-1 sm:max-w-[200px]" />
					<select value={data.filters.client} onchange={(e: Event) => updateFilters({ client: (e.currentTarget as HTMLSelectElement).value })} aria-label={t('label.filterByClient')}
						class="rounded-lg border border-border bg-input-bg text-near-black px-2.5 py-2 text-xs focus:border-cyan focus:outline-none focus:ring-1 focus:ring-cyan">
						{#each clientOptions as opt}
							<option value={opt.value}>{opt.label}</option>
						{/each}
					</select>
				</div>

				<div class="flex gap-1 overflow-x-auto" role="radiogroup" tabindex="-1" aria-label={t('label.filterByStatus')}
					onkeydown={(e: KeyboardEvent) => {
						if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
						e.preventDefault();
						const btns = (e.currentTarget as HTMLElement).querySelectorAll<HTMLButtonElement>('[role="radio"]');
						const idx = Array.from(btns).findIndex(b => b === document.activeElement);
						const next = e.key === 'ArrowRight' ? (idx + 1) % btns.length : (idx - 1 + btns.length) % btns.length;
						btns[next].focus();
						btns[next].click();
					}}>
					{#each ([{ value: '', tKey: 'status.all' }, { value: 'draft', tKey: 'status.draft' }, { value: 'sent', tKey: 'status.sent' }, { value: 'accepted', tKey: 'status.accepted' }, { value: 'rejected', tKey: 'status.rejected' }, { value: 'expired', tKey: 'status.expired' }] as const) as s}
						<button
							class="whitespace-nowrap px-3 py-2.5 sm:py-1.5 rounded-full text-xs font-medium transition-colors
								{data.filters.status === s.value ? 'bg-cyan text-white' : 'bg-bg text-near-black/60 hover:text-near-black'}"
							onclick={() => updateFilters({ status: s.value })}
							role="radio"
							aria-checked={data.filters.status === s.value}
							tabindex={data.filters.status === s.value ? 0 : -1}
						>{t(s.tKey)}</button>
					{/each}
				</div>

				<div class="flex items-center gap-2 sm:ml-auto">
					<input type="date" value={data.filters.dateFrom} onchange={(e: Event) => updateFilters({ from: (e.currentTarget as HTMLInputElement).value })} aria-label={t('label.fromDate')} class="flex-1 sm:flex-none rounded border border-border bg-input-bg text-near-black px-2 py-1 text-xs focus:border-cyan focus:outline-none" />
					<span class="text-xs text-near-black/60">–</span>
					<input type="date" value={data.filters.dateTo} onchange={(e: Event) => updateFilters({ to: (e.currentTarget as HTMLInputElement).value })} aria-label={t('label.toDate')} class="flex-1 sm:flex-none rounded border border-border bg-input-bg text-near-black px-2 py-1 text-xs focus:border-cyan focus:outline-none" />
					{#if hasFilters}
						<button class="text-xs text-red hover:text-red-dark whitespace-nowrap" onclick={() => updateFilters({ q: '', status: '', client: '', from: '', to: '' })}>{t('action.clearFilters')}</button>
					{/if}
				</div>
			</div>

			<DataTable
				{columns}
				data={data.proposals}
				total={data.total}
				currentPage={data.page}
				pageSize={data.pageSize}
				onpagechange={handlePageChange}
				onrowclick={(p) => goto(`/proposals/${p.id}`)}
			>
				{#snippet row(p: Proposal)}
					<td class="px-4 py-3 font-medium">{p.documentId}</td>
					<td class="px-4 py-3 text-near-black/70">{p.buyer?.name ?? ''}</td>
					<td class="px-4 py-3 text-near-black/70">{formatDate(p.issueDate, dateFormat)}</td>
					<td class="px-4 py-3 text-near-black/70">{formatDate(p.validUntil, dateFormat)}</td>
					<td class="px-4 py-3 text-right font-medium tabular-nums">{formatMoney(p.totals.total, p.currency)}</td>
					<td class="px-4 py-3"><Badge variant={proposalBadgeVariant(p.status)}>{t('status.' + p.status)}</Badge></td>
				{/snippet}
			</DataTable>
		</Card>
	{/if}
</div>
