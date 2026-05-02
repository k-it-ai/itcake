<script lang="ts">
	import { enhance } from '$app/forms';
	import TopBar from '$components/layout/TopBar.svelte';
	import Button from '$components/ui/Button.svelte';
	import Card from '$components/ui/Card.svelte';
	import Input from '$components/ui/Input.svelte';
	import Select from '$components/ui/Select.svelte';
	import MoneyInput from '$components/ui/MoneyInput.svelte';
	import RichTextArea from '$components/ui/RichTextArea.svelte';
	import SearchInput from '$components/ui/SearchInput.svelte';
	import ConfirmDialog from '$components/ui/ConfirmDialog.svelte';
	import { toast } from '$components/ui/Toast.svelte';
	import { formatMoney } from '$lib/money.js';
	import { t } from '$lib/i18n/index.svelte.js';
	import type { PageData } from './$types.js';

	let { data }: { data: PageData } = $props();
	let showNewItem = $state(false);
	let showNewUnit = $state(false);
	let editingId = $state<string | null>(null);
	let deleteTarget = $state<{ type: 'item' | 'unit'; id: string; name: string } | null>(null);
	let deleteItemForm = $state<HTMLFormElement>();
	let deleteItemInput = $state<HTMLInputElement>();
	let deleteUnitForm = $state<HTMLFormElement>();
	let deleteUnitInput = $state<HTMLInputElement>();

	let newItemPrice = $state(0);
	let newItemDescription = $state('');

	let editItemPrice = $state(0);
	let editItemDescription = $state('');

	function startEdit(item: typeof data.catalogItems[0]) {
		editingId = item.id;
		editItemPrice = item.unitPrice;
		editItemDescription = item.description;
		showNewItem = false;
	}

	function resetNew() {
		showNewItem = true;
		editingId = null;
		newItemPrice = 0;
		newItemDescription = '';
	}

	let catalogSearch = $state('');
	let filteredCatalogItems = $derived(
		catalogSearch
			? data.catalogItems.filter(item => {
				if (item.id === editingId) return true;
				const q = catalogSearch.toLowerCase();
				return item.name.toLowerCase().includes(q) || item.description.toLowerCase().includes(q);
			})
			: data.catalogItems
	);

	const unitOptions = $derived([
		{ value: '', label: t('option.none') },
		...data.units.map((u) => ({ value: u.name, label: u.name }))
	]);
</script>

<svelte:head><title>{t('page.productsAndServices')} | ITCake</title></svelte:head>

<TopBar title={t('catalog.title')}>
	{#snippet children()}
		<div class="flex gap-2">
			<Button size="sm" variant="secondary" onclick={() => showNewUnit = true}>{t('button.addUnit')}</Button>
			<Button size="sm" onclick={resetNew}>{t('button.addItem')}</Button>
		</div>
	{/snippet}
</TopBar>

<div class="p-6 space-y-6">
	<Card>
		<div class="flex items-center justify-between mb-4">
			<h2 class="text-lg font-semibold">{t('section.items')} ({data.catalogItems.length})</h2>
			{#if data.catalogItems.length > 0}
				<SearchInput bind:value={catalogSearch} placeholder={t('search.placeholder')} class="w-48" />
			{/if}
		</div>
		{#if data.catalogItems.length === 0 && !showNewItem}
			<p class="text-sm text-near-black/60">{t('empty.noCatalogItems')}</p>
		{/if}

		{#if showNewItem}
			<form method="POST" action="?/createItem" class="mb-4 rounded-lg border border-cyan/30 bg-cyan/5 p-4" use:enhance={({ formData }) => {
				formData.set('unitPrice', String(newItemPrice));
				formData.set('description', newItemDescription);
				return async ({ result, update }) => {
					if (result.type === 'success') { showNewItem = false; newItemPrice = 0; newItemDescription = ''; toast(t('toast.itemCreated')); }
					await update();
				};
			}}>
				<h3 class="text-sm font-medium mb-3">{t('section.newItem')}</h3>
				<div class="grid grid-cols-1 gap-3 sm:grid-cols-2">
					<Input name="name" label={t('catalog.name')} required />
					<Select name="unit" label={t('catalog.unit')} options={unitOptions} />
					<MoneyInput bind:value={newItemPrice} currency={data.currency} label={t('catalog.unitPrice')} name="unitPrice" />
					<Input name="taxRate" type="number" label={t('label.taxRatePercent')} value="0" />
				</div>
				<div class="mt-3">
					<RichTextArea label={t('catalog.description')} bind:value={newItemDescription} rows={2} />
				</div>
				<input type="hidden" name="description" value={newItemDescription} />
				<div class="mt-3 flex gap-2 justify-end">
					<Button variant="secondary" size="sm" onclick={() => showNewItem = false}>{t('action.cancel')}</Button>
					<Button type="submit" size="sm">{t('action.create')}</Button>
				</div>
			</form>
		{/if}

		<div class="divide-y divide-border">
			{#each filteredCatalogItems as item}
				{#if editingId === item.id}
					<form method="POST" action="?/updateItem" class="py-4 -mx-2 px-2" use:enhance={({ formData }) => {
						formData.set('unitPrice', String(editItemPrice));
						formData.set('description', editItemDescription);
						return async ({ result, update }) => {
							if (result.type === 'success') { editingId = null; toast(t('toast.itemUpdated')); }
							await update();
						};
					}}>
						<input type="hidden" name="id" value={item.id} />
						<div class="grid grid-cols-1 gap-3 sm:grid-cols-2">
							<Input name="name" label={t('catalog.name')} required value={item.name} />
							<Select name="unit" label={t('catalog.unit')} options={unitOptions} value={item.unit} />
							<MoneyInput bind:value={editItemPrice} currency={data.currency} label={t('catalog.unitPrice')} name="unitPrice" />
							<Input name="taxRate" type="number" label={t('label.taxRatePercent')} value={String(item.taxRate)} />
						</div>
						<div class="mt-3">
							<RichTextArea label={t('catalog.description')} bind:value={editItemDescription} rows={2} />
						</div>
						<input type="hidden" name="description" value={editItemDescription} />
						<div class="mt-3 flex gap-2 justify-end">
							<Button variant="secondary" size="sm" onclick={() => editingId = null}>{t('action.cancel')}</Button>
							<button type="button" class="text-xs text-red hover:text-red-dark px-2" onclick={() => { editingId = null; deleteTarget = { type: 'item', id: item.id, name: item.name }; }}>{t('action.delete')}</button>
							<Button type="submit" size="sm">{t('action.save')}</Button>
						</div>
					</form>
				{:else}
					<button
						type="button"
						class="flex w-full items-center justify-between py-3.5 px-2 text-left transition-colors hover:bg-bg/50 rounded-lg -mx-2"
						onclick={() => startEdit(item)}
					>
						<div class="min-w-0 flex-1">
							<span class="text-sm font-semibold text-near-black">{item.name}</span>
							{#if item.description}
								<p class="text-xs text-near-black/60 truncate mt-0.5">{item.description.replace(/<[^>]*>/g, ' ').trim().substring(0, 120)}</p>
							{/if}
						</div>
						<div class="flex items-center gap-3 ml-4 shrink-0">
							<span class="text-sm font-medium tabular-nums">{formatMoney(item.unitPrice, data.currency)}</span>
							{#if item.unit}<span class="text-xs text-near-black/60">/{item.unit}</span>{/if}
							{#if item.taxRate > 0}<span class="text-xs text-near-black/60 bg-bg rounded px-1.5 py-0.5 ml-1">{item.taxRate}%</span>{/if}
							<svg class="h-4 w-4 text-near-black/50" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M15.232 5.232l3.536 3.536m-2.036-5.036a2.5 2.5 0 113.536 3.536L6.5 21.036H3v-3.572L16.732 3.732z" /></svg>
						</div>
					</button>
				{/if}
			{/each}
		</div>
	</Card>

	<!-- Units -->
	<Card>
		<h2 class="text-lg font-semibold mb-4">{t('section.units')} ({data.units.length})</h2>
		{#if data.units.length === 0 && !showNewUnit}
			<p class="text-sm text-near-black/60">{t('empty.noCatalogUnits')}</p>
		{/if}

		{#if showNewUnit}
			<form method="POST" action="?/createUnit" class="mb-4 flex gap-2 items-end" use:enhance={() => {
				return async ({ result, update }) => {
					if (result.type === 'success') { showNewUnit = false; toast(t('toast.unitCreated')); }
					await update();
				};
			}}>
				<div class="flex-1"><Input name="name" label={t('label.unitName')} required /></div>
				<Button variant="secondary" size="sm" onclick={() => showNewUnit = false}>{t('action.cancel')}</Button>
				<Button type="submit" size="sm">{t('action.create')}</Button>
			</form>
		{/if}

		<div class="flex flex-wrap gap-2">
			{#each data.units as unit}
				<span class="inline-flex items-center gap-1 rounded-full bg-bg px-3 py-1 text-sm">
					{unit.name}
					<button onclick={() => deleteTarget = { type: 'unit', id: unit.id, name: unit.name }}
						class="text-near-black/50 hover:text-red ml-1">&times;</button>
				</span>
			{/each}
		</div>
	</Card>
</div>

{#if deleteTarget}
	<ConfirmDialog
		open={true}
		title={t('dialog.deleteCatalogItem', { type: deleteTarget.type === 'item' ? t('misc.item') : t('misc.unit') })}
		message={t('dialog.deleteCatalogItemMessage', { name: deleteTarget.name })}
		confirmLabel={t('action.delete')}
		onconfirm={() => {
			if (!deleteTarget) return;
			if (deleteTarget.type === 'item' && deleteItemInput && deleteItemForm) {
				deleteItemInput.value = deleteTarget.id;
				deleteItemForm.requestSubmit();
			} else if (deleteTarget.type === 'unit' && deleteUnitInput && deleteUnitForm) {
				deleteUnitInput.value = deleteTarget.id;
				deleteUnitForm.requestSubmit();
			}
			deleteTarget = null;
		}}
		oncancel={() => deleteTarget = null}
	/>
{/if}

<form bind:this={deleteItemForm} method="POST" action="?/deleteItem" class="hidden" use:enhance={() => {
	return async ({ result, update }) => {
		if (result.type === 'success') toast(t('toast.itemDeleted'));
		await update();
	};
}}>
	<input bind:this={deleteItemInput} name="id" type="hidden" />
</form>

<form bind:this={deleteUnitForm} method="POST" action="?/deleteUnit" class="hidden" use:enhance={() => {
	return async ({ result, update }) => {
		if (result.type === 'success') toast(t('toast.unitDeleted'));
		await update();
	};
}}>
	<input bind:this={deleteUnitInput} name="id" type="hidden" />
</form>
