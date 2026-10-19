<script lang="ts">
	import { t } from '#lib/i18n/index.svelte.js';

	interface Props {
		total: number;
		page: number;
		pageSize?: number;
		onchange: (page: number) => void;
		class?: string;
	}

	let { total, page, pageSize = 25, onchange, class: className = '' }: Props = $props();

	let totalPages = $derived(Math.max(1, Math.ceil(total / pageSize)));
	let current = $derived(Math.min(Math.max(1, page), totalPages));
	let rangeStart = $derived(total > 0 ? (current - 1) * pageSize + 1 : 0);
	let rangeEnd = $derived(Math.min(current * pageSize, total));
</script>

{#if totalPages > 1}
	<nav aria-label={t('aria.pagination')} class="flex items-center justify-between border-t border-line px-4 py-3 {className}">
		<p class="text-xs text-ink/60" aria-live="polite">
			{rangeStart}–{rangeEnd} {t('misc.of')} {total}
		</p>
		<div class="flex gap-1">
			<button
				type="button"
				class="rounded px-2.5 py-1 text-xs font-medium transition-colors {current === 1 ? 'text-ink/25 cursor-not-allowed' : 'text-ink/60 hover:bg-bg hover:text-ink'}"
				disabled={current === 1}
				onclick={() => onchange(Math.max(1, current - 1))}
				aria-label={t('aria.previousPage')}
			>{t('misc.previous')}</button>
			{#each Array.from({ length: totalPages }, (_, i) => i + 1) as pageNo}
				{#if totalPages <= 7 || pageNo === 1 || pageNo === totalPages || Math.abs(pageNo - current) <= 1}
					<button
						type="button"
						class="rounded px-2.5 py-1 text-xs font-medium transition-colors {pageNo === current ? 'bg-brand text-white' : 'text-ink/60 hover:bg-bg hover:text-ink'}"
						onclick={() => onchange(pageNo)}
						aria-label="{t('misc.page')} {pageNo}"
						aria-current={pageNo === current ? 'page' : undefined}
					>{pageNo}</button>
				{:else if Math.abs(pageNo - current) === 2}
					<span class="px-1 text-xs text-ink/50" aria-hidden="true">...</span>
				{/if}
			{/each}
			<button
				type="button"
				class="rounded px-2.5 py-1 text-xs font-medium transition-colors {current === totalPages ? 'text-ink/25 cursor-not-allowed' : 'text-ink/60 hover:bg-bg hover:text-ink'}"
				disabled={current === totalPages}
				onclick={() => onchange(Math.min(totalPages, current + 1))}
				aria-label={t('aria.nextPage')}
			>{t('misc.next')}</button>
		</div>
	</nav>
{/if}
