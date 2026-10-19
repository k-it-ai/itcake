<script lang="ts">
	import MoneyInput from '#components/ui/MoneyInput.svelte';
	import RichTextArea from '#components/ui/RichTextArea.svelte';
	import Button from '#components/ui/Button.svelte';
	import ConfirmDialog from '#components/ui/ConfirmDialog.svelte';
	import CatalogItemPicker from '#components/forms/CatalogItemPicker.svelte';
	import { getCurrencyDecimals } from '#lib/currencies.js';
	import { t } from '#lib/i18n/index.svelte.js';
	import type { LineItem, CatalogItem } from '#lib/types.js';

	interface Props {
		items: LineItem[];
		currency?: string;
		defaultTaxRate?: number;
		catalogItems?: CatalogItem[];
	}

	let {
		items = $bindable([]),
		currency = 'EUR',
		defaultTaxRate = 21,
		catalogItems = []
	}: Props = $props();

	let showCatalogPicker = $state(false);
	let showConvertConfirm = $state(false);
	let convertTargetIndex = $state<number | null>(null);
	let dragIndex = $state<number | null>(null);
	let dragOverIndex = $state<number | null>(null);
	let expandedIndex = $state<number | null>(null);

	function handleCatalogSelect(item: LineItem) {
		items = [...items, item];
	}

	function handleDragStart(index: number) { dragIndex = index; }
	function handleDragOver(e: DragEvent, index: number) { e.preventDefault(); dragOverIndex = index; }
	function handleDrop(e: DragEvent, index: number) {
		e.preventDefault();
		if (dragIndex !== null && dragIndex !== index) {
			const expandedId = expandedIndex !== null ? items[expandedIndex]?.id : null;
			const reordered = [...items];
			const [moved] = reordered.splice(dragIndex, 1);
			reordered.splice(index, 0, moved);
			items = reordered;
			if (expandedId) {
				const newIdx = reordered.findIndex(item => item.id === expandedId);
				expandedIndex = newIdx >= 0 ? newIdx : null;
			}
		}
		dragIndex = null;
		dragOverIndex = null;
	}
	function handleDragEnd() { dragIndex = null; dragOverIndex = null; }

	function generateItemId(): string { return crypto.randomUUID(); }

	function addItem() {
		items = [...items, {
			id: generateItemId(),
			name: '',
			description: '',
			quantity: 1,
			unit: '',
			unitPrice: 0,
			taxRate: defaultTaxRate,
			items: []
		}];
		expandedIndex = items.length - 1;
	}

	function addSubItem(parentIndex: number) {
		items = items.map((item, i) => {
			if (i !== parentIndex) return item;
			const isAlreadyGroup = item.items.length > 0;
			return {
				...item,
				...(isAlreadyGroup ? {} : { quantity: 1, unitPrice: 0, taxRate: 0 }),
				items: [...item.items, {
					id: generateItemId(),
					name: '',
					description: '',
					quantity: 1,
					unit: '',
					unitPrice: 0,
					taxRate: defaultTaxRate,
					items: []
				}]
			};
		});
	}

	function removeItem(index: number) {
		items = items.filter((_, i) => i !== index);
		if (expandedIndex === index) expandedIndex = null;
	}

	function removeSubItem(parentIndex: number, subIndex: number) {
		items = items.map((item, i) =>
			i === parentIndex
				? { ...item, items: item.items.filter((_, j) => j !== subIndex) }
				: item
		);
	}

	function moveItem(index: number, direction: -1 | 1) {
		const target = index + direction;
		if (target < 0 || target >= items.length) return;
		const reordered = [...items];
		[reordered[index], reordered[target]] = [reordered[target], reordered[index]];
		items = reordered;
		if (expandedIndex === index) expandedIndex = target;
		else if (expandedIndex === target) expandedIndex = index;
	}

	function computeLineTotal(item: LineItem): number {
		if (item.items.length > 0) {
			return item.items.reduce((sum, sub) => sum + computeLineTotal(sub), 0);
		}
		return Math.round(item.quantity * item.unitPrice);
	}

	function formatAmount(cents: number): string {
		const decimals = getCurrencyDecimals(currency) ?? 2;
		return (cents / Math.pow(10, decimals)).toFixed(decimals);
	}

	function stripHtml(html: string): string {
		return html.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
	}
</script>

<div class="space-y-2">
	{#each items as item, i}
		<!-- svelte-ignore a11y_no_static_element_interactions -->
		<div
			class="rounded-lg border bg-card transition-colors {dragOverIndex === i && dragIndex !== i ? 'border-brand-2 border-2' : 'border-line'} {dragIndex === i ? 'opacity-40' : ''}"
			draggable="true"
			ondragstart={() => handleDragStart(i)}
			ondragover={(e) => handleDragOver(e, i)}
			ondrop={(e) => handleDrop(e, i)}
			ondragend={handleDragEnd}
		>
			<div class="flex items-center gap-2 px-3 py-2.5">
				<div class="flex items-center gap-0 shrink-0">
					<div class="cursor-grab p-2.5 text-ink/50 touch-manipulation" aria-hidden="true">
						<svg class="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 8h16M4 16h16" /></svg>
					</div>
					<button type="button" onclick={() => moveItem(i, -1)} disabled={i === 0} class="p-2.5 text-ink/50 hover:text-ink disabled:opacity-20 disabled:cursor-not-allowed touch-manipulation" title={t('aria.moveUp')} aria-label={t('aria.moveUp')}>
						<svg class="h-3.5 w-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M5 15l7-7 7 7" /></svg>
					</button>
					<button type="button" onclick={() => moveItem(i, 1)} disabled={i === items.length - 1} class="p-2.5 text-ink/50 hover:text-ink disabled:opacity-20 disabled:cursor-not-allowed touch-manipulation" title={t('aria.moveDown')} aria-label={t('aria.moveDown')}>
						<svg class="h-3.5 w-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 9l-7 7-7-7" /></svg>
					</button>
				</div>

				<button type="button" class="flex-1 min-w-0 text-left" onclick={() => expandedIndex = expandedIndex === i ? null : i} aria-expanded={expandedIndex === i}>
					<span class="text-sm font-semibold text-ink truncate block">
						{item.name || t('lineItem.untitled')}
					</span>
					{#if item.description && expandedIndex !== i}
						<span class="text-xs text-ink/60 truncate block">{stripHtml(item.description).substring(0, 80)}</span>
					{/if}
				</button>

				<div class="flex items-center gap-3 shrink-0">
					{#if item.items.length === 0}
						<span class="text-xs text-ink/60 tabular-nums">{item.quantity} x {formatAmount(item.unitPrice)}</span>
					{/if}
					<span class="text-sm font-medium tabular-nums">{formatAmount(computeLineTotal(item))}</span>
					<button type="button" onclick={() => expandedIndex = expandedIndex === i ? null : i} class="p-2 text-ink/50 hover:text-ink touch-manipulation" title={t(expandedIndex === i ? 'aria.collapseItem' : 'aria.expandItem')} aria-expanded={expandedIndex === i} aria-label={t(expandedIndex === i ? 'aria.collapseItem' : 'aria.expandItem')}>
						<svg class="h-4 w-4 transition-transform {expandedIndex === i ? 'rotate-180' : ''}" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 9l-7 7-7-7" /></svg>
					</button>
					<button type="button" onclick={() => removeItem(i)} class="p-2 text-ink/50 hover:text-bad touch-manipulation" title={t('lineItem.removeItem')} aria-label={t('lineItem.removeItem')}>
						<svg class="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12" /></svg>
					</button>
				</div>
			</div>

			{#if expandedIndex === i}
				<div class="px-3 pb-3 border-t border-line/50 pt-3 space-y-3">
					<input type="text" bind:value={item.name} placeholder={t('lineItem.namePlaceholder')}
						class="w-full rounded border border-line bg-input-bg text-ink px-3 py-2 text-sm font-semibold focus:border-brand-2 focus:outline-none focus:ring-1 focus:ring-cyan" />

					<RichTextArea bind:value={item.description} rows={2} placeholder={t('lineItem.descriptionPlaceholder')} />

					{#if item.items.length === 0}
						<div class="grid grid-cols-2 gap-3 items-end sm:grid-cols-12">
							<div class="sm:col-span-2">
								<label for="qty-{i}" class="text-xs text-ink/60">{t('lineItem.quantity')}</label>
								<input id="qty-{i}" type="number" bind:value={item.quantity} step="0.01" min="0"
									class="w-full rounded border border-line bg-input-bg text-ink px-2 py-1.5 text-sm text-right tabular-nums focus:border-brand-2 focus:outline-none" />
							</div>
							<div class="sm:col-span-2">
								<label for="unit-{i}" class="text-xs text-ink/60">{t('lineItem.unit')}</label>
								<input id="unit-{i}" type="text" bind:value={item.unit} placeholder={t('placeholder.unitExample')}
									class="w-full rounded border border-line bg-input-bg text-ink px-2 py-1.5 text-sm focus:border-brand-2 focus:outline-none" />
							</div>
							<div class="sm:col-span-3">
								<MoneyInput bind:value={item.unitPrice} {currency} label={t('lineItem.unitPrice')} name="price-{i}" />
							</div>
							<div class="sm:col-span-2">
								<label for="tax-{i}" class="text-xs text-ink/60">{t('lineItem.taxPercent')}</label>
								<input id="tax-{i}" type="number" bind:value={item.taxRate} step="0.1" min="0" max="100"
									class="w-full rounded border border-line bg-input-bg text-ink px-2 py-1.5 text-sm text-right tabular-nums focus:border-brand-2 focus:outline-none" />
							</div>
							<div class="sm:col-span-3 text-right">
								<span class="text-xs text-ink/60">{t('lineItem.total')}</span>
								<p class="py-1.5 text-sm font-medium tabular-nums">{formatAmount(computeLineTotal(item))}</p>
							</div>
						</div>
					{:else}
						<div class="ml-4 space-y-2 border-l-2 border-brand-2/30 pl-4">
							{#each item.items as subItem, j}
								<div class="rounded border border-line bg-bg/50 p-3 space-y-2">
									<div class="flex gap-2">
										<input type="text" bind:value={subItem.name} placeholder={t('lineItem.subItemPlaceholder')}
											class="flex-1 rounded border border-line bg-input-bg text-ink px-2 py-1.5 text-sm font-medium focus:border-brand-2 focus:outline-none" />
										<button type="button" onclick={() => removeSubItem(i, j)} class="p-1.5 text-ink/50 hover:text-bad" aria-label={t('aria.removeSubItem')}>
											<svg class="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12" /></svg>
										</button>
									</div>
									<div class="grid grid-cols-2 gap-2 items-end sm:grid-cols-12">
										<div class="sm:col-span-2">
											<label for="sub-qty-{i}-{j}" class="text-xs text-ink/60">{t('lineItem.quantity')}</label>
											<input id="sub-qty-{i}-{j}" type="number" bind:value={subItem.quantity} step="0.01" min="0"
												class="w-full rounded border border-line bg-input-bg text-ink px-2 py-1 text-xs text-right tabular-nums focus:border-brand-2 focus:outline-none" />
										</div>
										<div class="sm:col-span-2">
											<label for="sub-unit-{i}-{j}" class="text-xs text-ink/60">{t('lineItem.unit')}</label>
											<input id="sub-unit-{i}-{j}" type="text" bind:value={subItem.unit} placeholder={t('placeholder.unitExample')}
												class="w-full rounded border border-line bg-input-bg text-ink px-2 py-1 text-xs focus:border-brand-2 focus:outline-none" />
										</div>
										<div class="sm:col-span-3">
											<MoneyInput bind:value={subItem.unitPrice} {currency} label={t('lineItem.unitPrice')} name="sub-price-{i}-{j}" />
										</div>
										<div class="sm:col-span-2">
											<label for="sub-tax-{i}-{j}" class="text-xs text-ink/60">{t('lineItem.taxPercent')}</label>
											<input id="sub-tax-{i}-{j}" type="number" bind:value={subItem.taxRate} step="0.1" min="0" max="100"
												class="w-full rounded border border-line bg-input-bg text-ink px-2 py-1 text-xs text-right tabular-nums focus:border-brand-2 focus:outline-none" />
										</div>
										<div class="sm:col-span-3 text-right">
											<span class="text-xs text-ink/60">{t('lineItem.total')}</span>
											<p class="py-1 text-xs font-medium tabular-nums">{formatAmount(computeLineTotal(subItem))}</p>
										</div>
									</div>
								</div>
							{/each}
							<button type="button" onclick={() => addSubItem(i)} class="text-xs text-brand hover:text-brand-ink">+ {t('lineItem.addSubItem')}</button>
						</div>
					{/if}

					{#if item.items.length === 0}
						<button type="button" onclick={() => { convertTargetIndex = i; showConvertConfirm = true; }} class="text-xs text-brand hover:text-brand-ink">+ {t('lineItem.convertToGroupAction')}</button>
					{/if}
				</div>
			{/if}
		</div>
	{/each}

	<div class="flex gap-2">
		<Button variant="secondary" size="sm" onclick={addItem}>+ {t('lineItem.addItem')}</Button>
		{#if catalogItems.length > 0}
			<Button variant="secondary" size="sm" onclick={() => showCatalogPicker = true}>+ {t('lineItem.fromCatalog')}</Button>
		{/if}
	</div>
</div>

<ConfirmDialog
	bind:open={showConvertConfirm}
	title={t('lineItem.convertToGroup')}
	message={t('lineItem.convertToGroupMessage')}
	confirmLabel={t('lineItem.convertLabel')}
	variant="primary"
	onconfirm={() => { if (convertTargetIndex !== null) addSubItem(convertTargetIndex); showConvertConfirm = false; convertTargetIndex = null; }}
	oncancel={() => { showConvertConfirm = false; convertTargetIndex = null; }}
/>

{#if catalogItems.length > 0}
	<CatalogItemPicker
		bind:open={showCatalogPicker}
		{catalogItems}
		{currency}
		{defaultTaxRate}
		onselect={handleCatalogSelect}
		onclose={() => showCatalogPicker = false}
	/>
{/if}
