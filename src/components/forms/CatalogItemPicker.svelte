<script lang="ts">
	import Modal from '#components/ui/Modal.svelte';
	import SearchInput from '#components/ui/SearchInput.svelte';
	import { formatMoney } from '#lib/money.js';
	import { t } from '#lib/i18n/index.svelte.js';
	import type { CatalogItem, LineItem } from '#lib/types.js';

	interface Props {
		open: boolean;
		catalogItems: CatalogItem[];
		currency?: string;
		defaultTaxRate?: number;
		onselect: (item: LineItem) => void;
		onclose: () => void;
	}

	let { open = $bindable(false), catalogItems, currency = 'EUR', defaultTaxRate = 21, onselect, onclose }: Props = $props();

	let search = $state('');

	let filtered = $derived.by(() => {
		if (!search) return catalogItems;
		const q = search.toLowerCase();
		return catalogItems.filter(
			(ci) => ci.name.toLowerCase().includes(q) || (ci.description ?? '').toLowerCase().includes(q)
		);
	});

	function handleSelect(ci: CatalogItem) {
		onselect({
			id: crypto.randomUUID(),
			name: ci.name,
			description: ci.description || '',
			quantity: 1,
			unit: ci.unit,
			unitPrice: ci.unitPrice,
			taxRate: ci.taxRate || defaultTaxRate,
			items: []
		});
		open = false;
		search = '';
	}
</script>

<Modal {open} title={t('catalog.addFromCatalog')} {onclose}>
	{#snippet children()}
		<SearchInput bind:value={search} placeholder={t('catalog.searchPlaceholder')} class="mb-4 w-full" />
		<div class="max-h-80 overflow-y-auto -mx-1">
			{#if filtered.length === 0}
				<p class="text-center text-sm text-ink/60 py-6">{t('catalog.noResults')}</p>
			{:else}
				{#each filtered as ci}
					<button
						class="w-full text-left px-3 py-2.5 rounded-lg hover:bg-bg/80 transition-colors flex items-center justify-between gap-4"
						onclick={() => handleSelect(ci)}
					>
						<div class="min-w-0">
							<p class="text-sm font-medium text-ink truncate">{ci.name}</p>
							{#if ci.description}
								<p class="text-xs text-ink/60 truncate">{ci.description.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim()}</p>
							{/if}
						</div>
						<div class="text-right shrink-0">
							<p class="text-sm font-medium tabular-nums">{formatMoney(ci.unitPrice, currency)}</p>
							{#if ci.unit}
								<p class="text-xs text-ink/60">{t('catalog.perUnit', { unit: ci.unit })}</p>
							{/if}
						</div>
					</button>
				{/each}
			{/if}
		</div>
	{/snippet}
</Modal>
