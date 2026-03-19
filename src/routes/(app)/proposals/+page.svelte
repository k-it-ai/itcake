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
	import type { Proposal, ProposalStatus } from '$lib/types.js';
	import type { PageData } from './$types.js';

	let { data }: { data: PageData } = $props();

	let dateFormat = $derived(data.settings?.general?.dateFormat || 'DD/MM/YYYY');

	let search = $state('');
	let statusFilter = $state<ProposalStatus | ''>('');
	let clientFilter = $state('');
	let dateFrom = $state('');
	let dateTo = $state('');

	let columns = $derived([
		{ key: 'documentId', label: t('proposal.number'), sortable: true },
		{ key: 'buyer', label: t('invoice.client'), sortable: true },
		{ key: 'issueDate', label: t('invoice.date'), sortable: true },
		{ key: 'validUntil', label: t('proposal.validUntil'), sortable: true },
		{ key: 'total', label: t('invoice.amount'), sortable: true, class: 'text-right' },
		{ key: 'status', label: t('invoice.status') },
	]);

	let clientOptions = $derived.by(() => {
		const names = [...new Set((data.proposals as Proposal[]).map((p) => p.buyer?.name ?? ''))].filter(Boolean).sort();
		return [{ value: '', label: t('invoice.allClients') }, ...names.map((n) => ({ value: n, label: n }))];
	});

	let filtered = $derived.by(() => {
		let result = data.proposals as Proposal[];
		if (statusFilter) result = result.filter((p) => p.status === statusFilter);
		if (clientFilter) result = result.filter((p) => p.buyer?.name === clientFilter);
		if (search) {
			const q = search.toLowerCase();
			result = result.filter((p) =>
				p.documentId.toLowerCase().includes(q) || (p.buyer?.name ?? '').toLowerCase().includes(q)
			);
		}
		if (dateFrom) result = result.filter((p) => p.issueDate >= dateFrom);
		if (dateTo) result = result.filter((p) => p.issueDate <= dateTo);
		return result;
	});

	let hasFilters = $derived(statusFilter !== '' || clientFilter !== '' || dateFrom !== '' || dateTo !== '' || search !== '');
</script>

<svelte:head><title>{t('proposal.titlePlural')} | ITCake</title></svelte:head>

<TopBar title={t('proposal.titlePlural')}>
	{#snippet children()}
		<Button size="sm" onclick={() => goto('/proposals/new')}>+ {t('proposal.new')}</Button>
	{/snippet}
</TopBar>

<div class="p-6">
	{#if data.proposals.length === 0}
		<Card>
			<EmptyState title={t('empty.noProposals')} description={t('empty.createFirstProposal')}>
				{#snippet children()}
					<Button onclick={() => goto('/proposals/new')}>+ {t('proposal.new')}</Button>
				{/snippet}
			</EmptyState>
		</Card>
	{:else}
		<Card flush>
			<div class="flex flex-col gap-3 p-3 border-b border-border sm:flex-row sm:flex-wrap sm:items-center sm:p-4">
				<div class="flex items-center gap-2 w-full sm:w-auto">
					<SearchInput bind:value={search} placeholder={t('search.placeholder')} class="flex-1 sm:max-w-[200px]" />
					<select bind:value={clientFilter} aria-label={t('label.filterByClient')}
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
								{statusFilter === s.value ? 'bg-cyan text-white' : 'bg-bg text-near-black/60 hover:text-near-black'}"
							onclick={() => statusFilter = s.value}
							role="radio"
							aria-checked={statusFilter === s.value}
							tabindex={statusFilter === s.value ? 0 : -1}
						>{t(s.tKey)}</button>
					{/each}
				</div>

				<div class="flex items-center gap-2 sm:ml-auto">
					<input type="date" bind:value={dateFrom} aria-label={t('label.fromDate')} class="flex-1 sm:flex-none rounded border border-border bg-input-bg text-near-black px-2 py-1 text-xs focus:border-cyan focus:outline-none" />
					<span class="text-xs text-near-black/60">–</span>
					<input type="date" bind:value={dateTo} aria-label={t('label.toDate')} class="flex-1 sm:flex-none rounded border border-border bg-input-bg text-near-black px-2 py-1 text-xs focus:border-cyan focus:outline-none" />
					{#if hasFilters}
						<button class="text-xs text-red hover:text-red-dark whitespace-nowrap" onclick={() => { search = ''; statusFilter = ''; clientFilter = ''; dateFrom = ''; dateTo = ''; }}>{t('action.clearFilters')}</button>
					{/if}
				</div>
			</div>

			<DataTable {columns} data={filtered} onrowclick={(p) => goto(`/proposals/${p.id}`)}>
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
