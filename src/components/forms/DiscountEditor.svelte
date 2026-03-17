<script lang="ts">
	import Button from '$components/ui/Button.svelte';
	import MoneyInput from '$components/ui/MoneyInput.svelte';
	import { t } from '$lib/i18n/index.svelte.js';
	import type { Discount } from '$lib/types.js';

	interface Props {
		discounts: Discount[];
		currency?: string;
	}

	let { discounts = $bindable([]), currency = 'EUR' }: Props = $props();

	function addDiscount() {
		discounts = [...discounts, { type: 'percentage', value: 0, description: '' }];
	}

	function removeDiscount(index: number) {
		discounts = discounts.filter((_, i) => i !== index);
	}
</script>

<div class="space-y-3">
	{#each discounts as discount, i}
		<div class="flex flex-wrap items-end gap-3">
			<div class="w-full sm:flex-1 sm:w-auto">
				<label for="disc-desc-{i}" class="text-xs text-near-black/60">{t('discount.description')}</label>
				<input id="disc-desc-{i}" type="text" bind:value={discount.description} placeholder={t('discount.reasonPlaceholder')}
					class="w-full rounded border border-border bg-input-bg text-near-black px-2 py-1.5 text-sm focus:border-cyan focus:outline-none" />
			</div>
			<div class="w-[calc(50%-0.375rem)] sm:w-28">
				<label for="disc-type-{i}" class="text-xs text-near-black/60">{t('discount.type')}</label>
				<select id="disc-type-{i}" bind:value={discount.type}
					class="w-full rounded border border-border bg-input-bg text-near-black px-2 py-1.5 text-sm focus:border-cyan focus:outline-none">
					<option value="percentage">%</option>
					<option value="fixed">{t('discount.fixed')}</option>
				</select>
			</div>
			<div class="w-[calc(50%-1.375rem)] sm:w-28">
				{#if discount.type === 'percentage'}
					<label for="disc-pct-{i}" class="text-xs text-near-black/60">{t('discount.percent')}</label>
					<div class="relative">
						<input id="disc-pct-{i}" type="number" bind:value={discount.value} step="0.1" min="0" max="100"
							class="w-full rounded border border-border bg-input-bg text-near-black px-2 py-1.5 pr-7 text-sm text-right tabular-nums focus:border-cyan focus:outline-none" />
						<span class="absolute right-2 top-1/2 -translate-y-1/2 text-xs text-near-black/60 pointer-events-none">%</span>
					</div>
				{:else}
					<MoneyInput bind:value={discount.value} {currency} label={t('discount.amount')} name="discount-{i}" />
				{/if}
			</div>
			<button type="button" onclick={() => removeDiscount(i)} class="mb-1 p-1.5 text-near-black/50 hover:text-red" aria-label={t('lineItem.removeItem')}>
				<svg class="h-5 w-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
					<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12" />
				</svg>
			</button>
		</div>
	{/each}
	<Button variant="secondary" size="sm" onclick={addDiscount}>+ {t('discount.add')}</Button>
</div>
