<script lang="ts" generics="T">
	import type { Snippet } from 'svelte';
	import { t } from '#lib/i18n/index.svelte.js';
	import Pager from '#lib/components/ui/Pager.svelte';

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
		sortKey?: string;
		sortDir?: 'asc' | 'desc';
		onsortchange?: (key: string, dir: 'asc' | 'desc') => void;
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
		onpagechange,
		sortKey,
		sortDir,
		onsortchange
	}: Props = $props();

	let localSortKey = $state('');
	let localSortDir = $state<'asc' | 'desc'>('asc');
	let localPage = $state(1);

	let isServerMode = $derived(total !== undefined && onpagechange !== undefined);

	let activeSortKey = $derived(isServerMode ? (sortKey ?? '') : localSortKey);
	let activeSortDir = $derived(isServerMode ? (sortDir ?? 'asc') : localSortDir);

	let effectivePage = $derived(isServerMode ? (currentPage ?? 1) : localPage);

	$effect(() => {
		data; // track
		if (!isServerMode) {
			localPage = 1;
		}
	});

	function handleSort(key: string) {
		const nextDir: 'asc' | 'desc' = activeSortKey === key && activeSortDir === 'asc' ? 'desc' : 'asc';
		if (isServerMode) {
			// Server-paged tables sort on the server; local sorting would only
			// reorder the current page.
			onsortchange?.(key, nextDir);
			return;
		}
		localSortKey = key;
		localSortDir = nextDir;
	}

	let sortedData = $derived.by(() => {
		if (isServerMode || !localSortKey) return data;
		const col = columns.find((c) => c.key === localSortKey);
		return [...data].sort((a, b) => {
			let aVal: string | number;
			let bVal: string | number;
			if (col?.sortValue) {
				aVal = col.sortValue(a);
				bVal = col.sortValue(b);
			} else {
				aVal = (a as Record<string, unknown>)[localSortKey] as string | number ?? '';
				bVal = (b as Record<string, unknown>)[localSortKey] as string | number ?? '';
			}
			const cmp = String(aVal).localeCompare(String(bVal), undefined, { numeric: true });
			return localSortDir === 'asc' ? cmp : -cmp;
		});
	});

	let pagedData = $derived(
		isServerMode
			? data
			: sortedData.slice((effectivePage - 1) * pageSize, effectivePage * pageSize)
	);

	let displayTotal = $derived(isServerMode ? (total ?? 0) : sortedData.length);

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
							? (activeSortKey === col.key ? (activeSortDir === 'asc' ? 'ascending' : 'descending') : 'none')
							: undefined}
					>
						{#if col.sortable}
							<button class="inline-flex items-center gap-1 hover:text-ink" onclick={() => handleSort(col.key)}
								aria-label="{t('aria.sortBy', { label: col.label })}{activeSortKey === col.key ? (activeSortDir === 'asc' ? t('aria.sortAscending') : t('aria.sortDescending')) : ''}">
								{col.label}
								{#if activeSortKey === col.key}
									<svg class="h-3 w-3" fill="currentColor" viewBox="0 0 20 20">
										{#if activeSortDir === 'asc'}
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

	<Pager total={displayTotal} page={effectivePage} pageSize={pageSize} onchange={goToPage} />
</div>
