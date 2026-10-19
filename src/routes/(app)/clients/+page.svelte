<script lang="ts">
	import { goto } from '$app/navigation';
	import TopBar from '#lib/components/shell/TopBar.svelte';
	import Btn from '#lib/components/ui/Btn.svelte';
	import Card from '#lib/components/ui/Card.svelte';
	import Avatar from '#lib/components/ui/Avatar.svelte';
	import EmptyState from '#lib/components/ui/EmptyState.svelte';
	import { Plus, MoreHorizontal } from '#lib/icons/index.js';
	import { formatMoney } from '#lib/money.js';
	import { t } from '#lib/i18n/index.svelte.js';
	import type { Client } from '#lib/types.js';
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

	let hasFilters = $derived(data.filters.search !== '');

	let totalPages = $derived(Math.max(1, Math.ceil(data.total / data.pageSize)));

	let openBalanceCount = $derived(
		(data.clients as Client[]).reduce((acc, c) => acc + ((data.revenueMap[c.id]?.outstanding ?? 0) > 0 ? 1 : 0), 0)
	);

	let topbarSub = $derived.by(() => {
		if (data.total === 0) return undefined;
		const base = `${data.total} ${t('client.titlePlural').toLowerCase()}`;
		return openBalanceCount > 0 ? `${base} · ${openBalanceCount} ${t('dashboard.outstanding').toLowerCase()}` : base;
	});
</script>

<svelte:head><title>{t('client.titlePlural')} | ITCake</title></svelte:head>

<TopBar
	title={t('client.titlePlural')}
	breadcrumb={[t('crumb.workspace'), t('client.titlePlural')]}
	sub={topbarSub}
>
	{#snippet right()}
		<Btn variant="primary" size="sm" onclick={() => goto('/clients/new')}>
			{#snippet icon()}<Plus size={14} strokeWidth={1.6} />{/snippet}
			{t('client.new')}
		</Btn>
	{/snippet}
</TopBar>

<div class="p-5">
	{#if data.total === 0 && !hasFilters}
		<Card>
			<EmptyState title={t('client.noClients')} description={t('empty.createFirstClient')}>
				{#snippet actions()}
					<Btn variant="primary" size="sm" onclick={() => goto('/clients/new')}>
						{#snippet icon()}<Plus size={14} strokeWidth={1.6} />{/snippet}
						{t('client.new')}
					</Btn>
				{/snippet}
			</EmptyState>
		</Card>
	{:else}
		<Card padding={0}>
			<div
				class="flex flex-wrap items-center gap-2 border-b px-4 py-3"
				style="border-color:var(--line-2)"
			>
				<input
					type="search"
					value={data.filters.search}
					oninput={(e) => debouncedSearch((e.currentTarget as HTMLInputElement).value)}
					placeholder={t('search.placeholder')}
					aria-label={t('search.placeholder')}
					class="rounded-md border px-2.5 py-1.5 text-[12px] focus:outline-none focus:ring-2 focus:ring-[var(--brand)]"
					style="background:#fbfcfd;border-color:var(--line);color:var(--ink);min-width:220px"
				/>
				{#if hasFilters}
					<button
						class="text-[12px] underline hover:no-underline"
						style="color:var(--bad)"
						onclick={() => updateFilters({ q: '' })}
					>{t('action.clearFilters')}</button>
				{/if}
				<span class="ml-auto text-[11.5px]" style="color:var(--muted)">
					{data.total} {t('client.titlePlural').toLowerCase()}{openBalanceCount > 0 ? ` · ${openBalanceCount} ${t('dashboard.outstanding').toLowerCase()}` : ''}
				</span>
			</div>

			<div class="overflow-x-auto">
				<table class="w-full text-[12.5px] num">
					<thead>
						<tr style="border-bottom:1px solid var(--line-2)">
							<th class="px-4 py-2 text-left text-[10.5px] font-medium uppercase tracking-wide" style="color:var(--muted)">{t('client.name')}</th>
							<th class="px-4 py-2 text-left text-[10.5px] font-medium uppercase tracking-wide" style="color:var(--muted)">{t('label.id')}</th>
							<th class="px-4 py-2 text-left text-[10.5px] font-medium uppercase tracking-wide" style="color:var(--muted)">{t('client.email')}</th>
							<th class="px-4 py-2 text-left text-[10.5px] font-medium uppercase tracking-wide" style="color:var(--muted)">{t('settings.city')}</th>
							<th class="px-4 py-2 text-right text-[10.5px] font-medium uppercase tracking-wide" style="color:var(--muted)">{t('dashboard.outstanding')}</th>
							<th class="px-4 py-2 text-right text-[10.5px] font-medium uppercase tracking-wide" style="color:var(--muted)">{t('dashboard.revenue')}</th>
							<th class="w-8 px-2 py-2"></th>
						</tr>
					</thead>
					<tbody class="divide-y" style="--tw-divide-opacity:1">
						{#each data.clients as client (client.id)}
							{@const rev = data.revenueMap[client.id]}
							<tr
								class="cursor-pointer transition-colors hover:bg-[#fbfcfd]"
								style="border-color:var(--line-2)"
								onclick={() => goto(`/clients/${client.id}`)}
								onkeydown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); goto(`/clients/${client.id}`); } }}
								tabindex="0"
							>
								<td class="px-4 py-3">
									<div class="flex items-center gap-2.5">
										<Avatar name={client.name} size={22} />
										<span class="font-medium" style="color:var(--ink)">{client.name}</span>
									</div>
								</td>
								<td class="px-4 py-3" style="color:var(--muted);font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:11px">
									{client.clientNumber || '—'}
								</td>
								<td class="px-4 py-3" style="color:var(--muted)">{client.email}</td>
								<td class="px-4 py-3" style="color:var(--muted)">{client.address?.city || ''}</td>
								<td
									class="px-4 py-3 text-right tabular-nums"
									style={`color:${rev?.outstanding ? 'var(--bad)' : 'var(--muted)'};${rev?.outstanding ? 'font-weight:500' : ''}`}
								>{rev?.outstanding ? formatMoney(rev.outstanding, data.currency) : '—'}</td>
								<td class="px-4 py-3 text-right tabular-nums" style="color:{rev?.paid ? 'var(--ink)' : 'var(--muted)'}">
									{rev?.paid ? formatMoney(rev.paid, data.currency) : '—'}
								</td>
								<td class="px-2 py-3 text-right">
									<span aria-hidden="true" style="color:var(--muted)"><MoreHorizontal size={14} strokeWidth={1.6} /></span>
								</td>
							</tr>
						{/each}
					</tbody>
				</table>
				{#if data.clients.length === 0}
					<div class="px-4 py-8 text-center text-[12px]" style="color:var(--muted)">{t('search.noResults')}</div>
				{/if}
			</div>

			{#if totalPages > 1}
				<div
					class="flex items-center justify-between border-t px-4 py-2 text-[11.5px]"
					style="border-color:var(--line-2);color:var(--muted)"
				>
					<span>{data.page} / {totalPages}</span>
					<div class="flex gap-1">
						<Btn
							variant="ghost"
							size="sm"
							disabled={data.page <= 1}
							onclick={() => handlePageChange(data.page - 1)}
						>{t('misc.previous')}</Btn>
						<Btn
							variant="ghost"
							size="sm"
							disabled={data.page >= totalPages}
							onclick={() => handlePageChange(data.page + 1)}
						>{t('action.next')}</Btn>
					</div>
				</div>
			{/if}
		</Card>
	{/if}
</div>
