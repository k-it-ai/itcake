<script lang="ts">
	import { formatMoney, computeInvoiceTotals } from '$lib/money.js';
	import { t } from '$lib/i18n/index.svelte.js';
	import type { LineItem, Discount, PricingMode, InvoiceTotals } from '$lib/types.js';

	interface Props {
		items: LineItem[];
		discounts: Discount[];
		pricingMode: PricingMode;
		currency: string;
	}

	let { items, discounts, pricingMode, currency }: Props = $props();

	let totals: InvoiceTotals = $derived(computeInvoiceTotals(items, discounts, pricingMode));
</script>

<div class="space-y-2 text-sm">
	<div class="flex justify-between">
		<span class="text-ink/60">{t('totals.subtotal')}</span>
		<span class="tabular-nums">{formatMoney(totals.subtotal, currency)}</span>
	</div>

	{#if totals.discountAmount > 0}
		<div class="flex justify-between text-bad">
			<span>{t('totals.discount')}</span>
			<span class="tabular-nums">-{formatMoney(totals.discountAmount, currency)}</span>
		</div>
		<div class="flex justify-between">
			<span class="text-ink/60">{t('totals.subtotalAfterDiscounts')}</span>
			<span class="tabular-nums">{formatMoney(totals.subtotalAfterDiscounts, currency)}</span>
		</div>
	{/if}

	{#each totals.taxSubtotals as ts}
		<div class="flex justify-between">
			<span class="text-ink/60">{t('totals.tax')} {ts.rate}%</span>
			<span class="tabular-nums">{formatMoney(ts.taxAmount, currency)}</span>
		</div>
	{/each}

	{#if totals.totalTaxes > 0}
		<div class="flex justify-between border-t border-line pt-2">
			<span class="text-ink/60">{t('totals.totalTax')}</span>
			<span class="tabular-nums">{formatMoney(totals.totalTaxes, currency)}</span>
		</div>
	{/if}

	<div class="flex justify-between border-t border-line pt-2 text-base font-bold">
		<span>{t('totals.total')}</span>
		<span class="tabular-nums text-ink">{formatMoney(totals.total, currency)}</span>
	</div>

	{#if pricingMode === 'gross' && totals.totalTaxes > 0}
		<div class="flex justify-between text-xs">
			<span class="text-ink/60">{t('totals.netExclTax')}</span>
			<span class="tabular-nums text-ink/60">{formatMoney(totals.netTotal, currency)}</span>
		</div>
	{/if}
</div>
