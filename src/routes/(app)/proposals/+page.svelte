<script lang="ts">
	import { goto } from '$app/navigation';
	import TopBar from '#lib/components/shell/TopBar.svelte';
	import Btn from '#lib/components/ui/Btn.svelte';
	import Card from '#lib/components/ui/Card.svelte';
	import Dot from '#lib/components/ui/Dot.svelte';
	import EmptyState from '#lib/components/ui/EmptyState.svelte';
	import FilterChip from '#lib/components/ui/FilterChip.svelte';
	import { Plus } from '#lib/icons/index.js';
	import { formatMoney } from '#lib/money.js';
	import { formatDate } from '#lib/format-date.js';
	import Pager from '#lib/components/ui/Pager.svelte';
	import { t } from '#lib/i18n/index.svelte.js';
	import type { Proposal, ProposalStatus } from '#lib/types.js';
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
		goto(url.pathname + url.search, { replace: true, reset: false });
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

	let hasFilters = $derived(
		data.filters.status !== '' ||
			data.filters.client !== '' ||
			data.filters.dateFrom !== '' ||
			data.filters.dateTo !== '' ||
			data.filters.search !== ''
	);

	// Pipeline column definitions per assets/design/handoff-v2/05-pages.md §6.
	type ColumnTone = 'mute' | 'brand' | 'warn' | 'good' | 'bad';
	const columns: { status: ProposalStatus; label: string; tone: ColumnTone }[] = $derived([
		{ status: 'draft', label: t('status.draft'), tone: 'mute' },
		{ status: 'sent', label: t('status.sent'), tone: 'brand' },
		// "Viewed" is treated as "sent" until status tracking is added — keep one accent slot.
		{ status: 'rejected', label: t('status.rejected'), tone: 'bad' },
		{ status: 'accepted', label: t('status.accepted'), tone: 'good' },
		{ status: 'expired', label: t('status.expired'), tone: 'warn' }
	]);

	let groups = $derived.by(() => {
		const buckets = new Map<ProposalStatus, Proposal[]>();
		for (const c of columns) buckets.set(c.status, []);
		for (const p of data.proposals as Proposal[]) {
			const arr = buckets.get(p.status as ProposalStatus);
			if (arr) arr.push(p);
		}
		return buckets;
	});

	const toneToPillColor: Record<ColumnTone, string> = {
		mute: 'var(--muted)',
		brand: 'var(--brand-ink)',
		warn: '#7a4400',
		good: '#0f5d3d',
		bad: '#7a1a22'
	};

	let clientOptions = $derived([
		{ value: '', label: t('invoice.allClients') },
		...(data.clientNames as string[]).map((n: string) => ({ value: n, label: n }))
	]);
</script>

<svelte:head><title>{t('proposal.titlePlural')} | ITCake</title></svelte:head>

<TopBar
	title={t('proposal.titlePlural')}
	breadcrumb={[t('crumb.billing'), t('proposal.titlePlural')]}
	sub={data.total > 0 ? `${data.total} ${t('proposal.titlePlural').toLowerCase()}` : undefined}
>
	{#snippet right()}
		<Btn variant="primary" size="sm" onclick={() => goto('/proposals/new')}>
			{#snippet icon()}<Plus size={14} strokeWidth={1.6} />{/snippet}
			{t('proposal.new')}
		</Btn>
	{/snippet}
</TopBar>

<div class="p-5">
	{#if data.total === 0 && !hasFilters}
		<Card>
			<EmptyState title={t('empty.noProposals')} description={t('empty.createFirstProposal')}>
				{#snippet actions()}
					<Btn variant="primary" size="sm" onclick={() => goto('/proposals/new')}>
						{#snippet icon()}<Plus size={14} strokeWidth={1.6} />{/snippet}
						{t('proposal.new')}
					</Btn>
				{/snippet}
			</EmptyState>
		</Card>
	{:else}
		<div class="mb-3 flex flex-wrap items-center gap-2">
			<input
				type="search"
				value={data.filters.search}
				oninput={(e) => debouncedSearch((e.currentTarget as HTMLInputElement).value)}
				placeholder={t('search.placeholder')}
				aria-label={t('search.placeholder')}
				class="rounded-md border px-2.5 py-1.5 text-[12px] focus:outline-none focus:ring-2 focus:ring-[var(--brand)]"
				style="background:#fbfcfd;border-color:var(--line);color:var(--ink);min-width:220px"
			/>
			<select
				value={data.filters.client}
				onchange={(e) => updateFilters({ client: (e.currentTarget as HTMLSelectElement).value })}
				aria-label={t('label.filterByClient')}
				class="rounded-md border px-2.5 py-1.5 text-[12px] focus:outline-none focus:ring-2 focus:ring-[var(--brand)]"
				style="background:#fbfcfd;border-color:var(--line);color:var(--ink)"
			>
				{#each clientOptions as opt (opt.value)}
					<option value={opt.value}>{opt.label}</option>
				{/each}
			</select>
			<input
				type="date"
				value={data.filters.dateFrom}
				onchange={(e) => updateFilters({ from: (e.currentTarget as HTMLInputElement).value })}
				aria-label={t('label.fromDate')}
				class="rounded-md border px-2 py-1.5 text-[12px] focus:outline-none focus:ring-2 focus:ring-[var(--brand)]"
				style="background:#fbfcfd;border-color:var(--line);color:var(--ink)"
			/>
			<span class="text-[11px]" style="color:var(--muted)">–</span>
			<input
				type="date"
				value={data.filters.dateTo}
				onchange={(e) => updateFilters({ to: (e.currentTarget as HTMLInputElement).value })}
				aria-label={t('label.toDate')}
				class="rounded-md border px-2 py-1.5 text-[12px] focus:outline-none focus:ring-2 focus:ring-[var(--brand)]"
				style="background:#fbfcfd;border-color:var(--line);color:var(--ink)"
			/>
			{#if data.filters.status}
				<FilterChip
					label={t('invoice.status')}
					value={t(`status.${data.filters.status}`)}
					active
					onclick={() => updateFilters({ status: '' })}
				/>
			{/if}
			{#if hasFilters}
				<button
					class="text-[12px] underline hover:no-underline"
					style="color:var(--bad)"
					onclick={() => updateFilters({ q: '', status: '', client: '', from: '', to: '' })}
				>{t('action.clearFilters')}</button>
			{/if}
		</div>

		<div class="flex gap-3 overflow-auto pb-2 scrollbar-thin">
			{#each columns as col (col.status)}
				{@const items = groups.get(col.status) ?? []}
				<div class="shrink-0" style="width:240px">
					<div class="mb-2 flex items-center justify-between px-1">
						<div class="flex items-center gap-2">
							<Dot tone={col.tone} />
							<span class="text-[12.5px] font-semibold" style="color:var(--ink)">{col.label}</span>
							<span class="text-[11.5px]" style="color:var(--muted)">· {items.length}</span>
						</div>
						<button
							type="button"
							onclick={() => updateFilters({ status: col.status })}
							aria-label={t('label.filterByStatus')}
							class="rounded p-0.5 hover:bg-[var(--line-2)]"
							style="color:var(--muted)"
						>
							<Plus size={14} strokeWidth={1.6} />
						</button>
					</div>
					<div class="space-y-2">
						{#each items as p (p.id)}
							{@const isExpired = p.status === 'expired'}
							<a
								href="/proposals/{p.id}"
								class="block rounded-lg border bg-[var(--card)] shadow-card transition-colors hover:border-[var(--brand)]"
								style="padding:10px;border-color:var(--line)"
							>
								<div class="flex items-baseline justify-between gap-2">
									<span
										class="num text-[10.5px]"
										style="color:var(--muted);font-family:ui-monospace,SFMono-Regular,Menlo,monospace"
									>{p.documentId}</span>
									<span
										class="num text-[12px] font-semibold"
										style="color:var(--brand-ink)"
									>{formatMoney(p.totals.total, p.currency)}</span>
								</div>
								<div class="mt-0.5 truncate text-[12.5px] font-semibold" style="color:var(--ink)">
									{p.buyer?.name ?? p.documentId}
								</div>
								<div
									class="mt-0.5 text-[11px]"
									style="color:{isExpired ? 'var(--bad)' : 'var(--muted)'}"
								>
									{formatDate(p.issueDate, dateFormat)}
									{#if p.validUntil}
										· {t('proposal.validUntil')} {formatDate(p.validUntil, dateFormat)}
									{/if}
								</div>
								{#if p.status === 'sent'}
									<div class="mt-1 text-[11px] font-medium" style="color:{toneToPillColor.good}">
										{t('button.convertToInvoice')} →
									</div>
								{/if}
							</a>
						{/each}
						{#if items.length === 0}
							<div
								class="rounded-lg border border-dashed py-6 text-center text-[11px]"
								style="border-color:var(--line);color:var(--muted)"
							>—</div>
						{/if}
					</div>
				</div>
			{/each}
		</div>
		<Pager total={data.total} page={data.page} pageSize={data.pageSize} onchange={handlePageChange} />
	{/if}
</div>
