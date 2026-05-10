<script lang="ts" generics="T">
	import type { Snippet } from 'svelte';
	import { t } from '$lib/i18n/index.svelte.js';

	interface Column {
		key: string;
		label: string;
		sortable?: boolean;
		sortValue?: (item: T) => string | number;
		class?: string;
	}

	interface Props {
		columns: Column[];
		data: T[];
		row: Snippet<[T]>;
		emptyMessage?: string;
		onrowclick?: (item: T) => void;
		pageSize?: number;
		total?: number;
		currentPage?: number;
		onpagechange?: (page: number) => void;
	}

	let {
		columns,
		data,
		row,
		emptyMessage = t('empty.noItems'),
		onrowclick,
		pageSize = 25,
		total,
		currentPage,
		onpagechange
	}: Props = $props();

	let sortKey = $state('');
	let sortDir = $state<'asc' | 'desc'>('asc');
	let localPage = $state(1);

	let isServerMode = $derived(total !== undefined && onpagechange !== undefined);

	let effectivePage = $derived(isServerMode ? (currentPage ?? 1) : localPage);

	$effect(() => {
		data; // track
		if (!isServerMode) {
			localPage = 1;
		}
	});

	function handleSort(key: string) {
		if (sortKey === key) {
			sortDir = sortDir === 'asc' ? 'desc' : 'asc';
		} else {
			sortKey = key;
			sortDir = 'asc';
		}
	}

	let sortedData = $derived.by(() => {
		if (isServerMode || !sortKey) return data;
		const col = columns.find((c) => c.key === sortKey);
		return [...data].sort((a, b) => {
			let aVal: string | number;
			let bVal: string | number;
			if (col?.sortValue) {
				aVal = col.sortValue(a);
				bVal = col.sortValue(b);
			} else {
				aVal = (a as Record<string, unknown>)[sortKey] as string | number ?? '';
				bVal = (b as Record<string, unknown>)[sortKey] as string | number ?? '';
			}
			const cmp = String(aVal).localeCompare(String(bVal), undefined, { numeric: true });
			return sortDir === 'asc' ? cmp : -cmp;
		});
	});

	let totalPages = $derived(
		isServerMode
			? Math.max(1, Math.ceil((total ?? 0) / pageSize))
			: Math.max(1, Math.ceil(sortedData.length / pageSize))
	);

	let pagedData = $derived(
		isServerMode
			? data
			: sortedData.slice((effectivePage - 1) * pageSize, effectivePage * pageSize)
	);

	let displayTotal = $derived(isServerMode ? (total ?? 0) : sortedData.length);
	let displayStart = $derived((effectivePage - 1) * pageSize + 1);
	let displayEnd = $derived(Math.min(effectivePage * pageSize, displayTotal));

	function goToPage(p: number) {
		if (isServerMode) {
			onpagechange?.(p);
		} else {
			localPage = p;
		}
	}
</script>

<div class="overflow-x-auto">
	<table class="w-full text-sm">
		<thead>
			<tr class="border-b border-line">
				{#each columns as col}
					<th class="px-4 py-3 text-left font-medium text-ink/60 {col.class ?? ''}"
						aria-sort={col.sortable
							? (sortKey === col.key ? (sortDir === 'asc' ? 'ascending' : 'descending') : 'none')
							: undefined}
					>
						{#if col.sortable}
							<button class="inline-flex items-center gap-1 hover:text-ink" onclick={() => handleSort(col.key)}
								aria-label="{t('aria.sortBy', { label: col.label })}{sortKey === col.key ? (sortDir === 'asc' ? t('aria.sortAscending') : t('aria.sortDescending')) : ''}">
								{col.label}
								{#if sortKey === col.key}
									<svg class="h-3 w-3" fill="currentColor" viewBox="0 0 20 20">
										{#if sortDir === 'asc'}
											<path d="M5.293 9.707a1 1 0 010-1.414l4-4a1 1 0 011.414 0l4 4a1 1 0 01-1.414 1.414L10 6.414l-3.293 3.293a1 1 0 01-1.414 0z" />
										{:else}
											<path d="M14.707 10.293a1 1 0 010 1.414l-4 4a1 1 0 01-1.414 0l-4-4a1 1 0 111.414-1.414L10 13.586l3.293-3.293a1 1 0 011.414 0z" />
										{/if}
									</svg>
								{/if}
							</button>
						{:else}
							{col.label}
						{/if}
					</th>
				{/each}
			</tr>
		</thead>
		<tbody>
			{#if sortedData.length === 0}
				<tr>
					<td colspan={columns.length} class="px-4 py-8 text-center text-ink/60">
						{emptyMessage}
					</td>
				</tr>
			{:else}
				{#each pagedData as item}
					<tr
						class="border-b border-line last:border-0 hover:bg-bg/50 {onrowclick ? 'cursor-pointer' : ''}"
						onclick={() => onrowclick?.(item)}
						onkeydown={(e) => { if (onrowclick && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); onrowclick(item); } }}
						tabindex={onrowclick ? 0 : undefined}
						role={onrowclick ? 'row' : undefined}
						>
						{@render row(item)}
					</tr>
				{/each}
			{/if}
		</tbody>
	</table>

	{#if totalPages > 1}
		<nav aria-label={t('aria.pagination')} class="flex items-center justify-between border-t border-line px-4 py-3">
			<p class="text-xs text-ink/60" aria-live="polite">
				{displayStart}–{displayEnd} {t('misc.of')} {displayTotal}
			</p>
			<div class="flex gap-1">
				<button
					class="rounded px-2.5 py-1 text-xs font-medium transition-colors {effectivePage === 1 ? 'text-ink/25 cursor-not-allowed' : 'text-ink/60 hover:bg-bg hover:text-ink'}"
					disabled={effectivePage === 1}
					onclick={() => goToPage(Math.max(1, effectivePage - 1))}
					aria-label={t('aria.previousPage')}
				>{t('misc.previous')}</button>
				{#each Array.from({ length: totalPages }, (_, i) => i + 1) as page}
					{#if totalPages <= 7 || page === 1 || page === totalPages || Math.abs(page - effectivePage) <= 1}
						<button
							class="rounded px-2.5 py-1 text-xs font-medium transition-colors {page === effectivePage ? 'bg-brand text-white' : 'text-ink/60 hover:bg-bg hover:text-ink'}"
							onclick={() => goToPage(page)}
							aria-label="{t('misc.page')} {page}"
							aria-current={page === effectivePage ? 'page' : undefined}
						>{page}</button>
					{:else if Math.abs(page - effectivePage) === 2}
						<span class="px-1 text-xs text-ink/50" aria-hidden="true">...</span>
					{/if}
				{/each}
				<button
					class="rounded px-2.5 py-1 text-xs font-medium transition-colors {effectivePage === totalPages ? 'text-ink/25 cursor-not-allowed' : 'text-ink/60 hover:bg-bg hover:text-ink'}"
					disabled={effectivePage === totalPages}
					onclick={() => goToPage(Math.min(totalPages, effectivePage + 1))}
					aria-label={t('aria.nextPage')}
				>{t('misc.next')}</button>
			</div>
		</nav>
	{/if}
</div>
