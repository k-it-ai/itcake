<script lang="ts">
	import { enhance } from '$app/forms';
	import TopBar from '#lib/components/shell/TopBar.svelte';
	import Btn from '#lib/components/ui/Btn.svelte';
	import Card from '#lib/components/ui/Card.svelte';
	import SectionHead from '#lib/components/ui/SectionHead.svelte';
	import Tag from '#lib/components/ui/Tag.svelte';
	import Input from '#components/ui/Input.svelte';
	import Select from '#components/ui/Select.svelte';
	import MoneyInput from '#components/ui/MoneyInput.svelte';
	import RichTextArea from '#components/ui/RichTextArea.svelte';
	import ConfirmDialog from '#components/ui/ConfirmDialog.svelte';
	import { Plus, MoreHorizontal } from '#lib/icons/index.js';
	import { toast } from '#components/ui/Toast.svelte';
	import { formatMoney } from '#lib/money.js';
	import { t } from '#lib/i18n/index.svelte.js';
	import type { PageData } from './$types.js';

	let { data }: { data: PageData } = $props();
	let showNewItem = $state(false);
	let showNewUnit = $state(false);
	let editingId = $state<string | null>(null);
	let savingUnit = $state(false);
	let savingItem = $state(false);
	let savingEdit = $state(false);
	let deleting = $state(false);
	let deleteTarget = $state<{ type: 'item' | 'unit'; id: string; name: string } | null>(null);
	let deleteItemForm = $state<HTMLFormElement>();
	let deleteItemInput = $state<HTMLInputElement>();
	let deleteUnitForm = $state<HTMLFormElement>();
	let deleteUnitInput = $state<HTMLInputElement>();

	let newItemPrice = $state(0);
	let newItemDescription = $state('');

	let editItemPrice = $state(0);
	let editItemDescription = $state('');

	let activeUnitFilter = $state<string>('');

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
		(data.catalogItems as typeof data.catalogItems).filter(item => {
			if (item.id === editingId) return true;
			if (activeUnitFilter && item.unit !== activeUnitFilter) return false;
			if (catalogSearch) {
				const q = catalogSearch.toLowerCase();
				if (!item.name.toLowerCase().includes(q) && !item.description.toLowerCase().includes(q)) {
					return false;
				}
			}
			return true;
		})
	);

	const unitOptions = $derived([
		{ value: '', label: t('option.none') },
		...data.units.map((u) => ({ value: u.name, label: u.name }))
	]);

	let unitCounts = $derived.by(() => {
		const counts: Record<string, number> = {};
		for (const item of data.catalogItems) {
			const key = item.unit || '';
			counts[key] = (counts[key] ?? 0) + 1;
		}
		return counts;
	});
</script>

<svelte:head><title>{t('page.productsAndServices')} | ITCake</title></svelte:head>

<TopBar
	title={t('catalog.title')}
	breadcrumb={[t('crumb.workspace'), t('catalog.title')]}
	sub={`${data.catalogItems.length} ${t('section.items').toLowerCase()}`}
>
	{#snippet right()}
		<Btn variant="ghost" size="sm" onclick={() => showNewUnit = true}>{t('button.addUnit')}</Btn>
		<Btn variant="primary" size="sm" onclick={resetNew}>
			{#snippet icon()}<Plus size={14} strokeWidth={1.6} />{/snippet}
			{t('button.addItem')}
		</Btn>
	{/snippet}
</TopBar>

<div class="p-5">
	<div class="grid grid-cols-1 gap-4 lg:grid-cols-12">
		<div class="lg:col-span-3">
			<Card padding={0}>
				<div class="border-b px-4 py-3" style="border-color:var(--line-2)">
					<h3 class="text-[13px] font-semibold" style="color:var(--ink)">{t('section.units')}</h3>
				</div>
				<div class="py-1">
					<button
						type="button"
						onclick={() => activeUnitFilter = ''}
						class="flex w-full items-center justify-between px-4 py-1.5 text-left text-[12.5px] transition-colors"
						style={activeUnitFilter === ''
							? 'background:var(--brand-soft);color:var(--brand-ink);font-weight:600'
							: 'color:var(--ink)'}
					>
						<span>{t('status.all')}</span>
						<span class="num text-[11.5px]" style={activeUnitFilter === '' ? 'color:var(--brand-ink)' : 'color:var(--muted)'}>{data.catalogItems.length}</span>
					</button>
					{#each data.units as unit (unit.id)}
						<div class="flex items-center">
							<button
								type="button"
								onclick={() => activeUnitFilter = unit.name}
								class="flex flex-1 items-center justify-between px-4 py-1.5 text-left text-[12.5px] transition-colors"
								style={activeUnitFilter === unit.name
									? 'background:var(--brand-soft);color:var(--brand-ink);font-weight:600'
									: 'color:var(--ink)'}
							>
								<span class="truncate">{unit.name}</span>
								<span class="ml-2 num text-[11.5px]" style={activeUnitFilter === unit.name ? 'color:var(--brand-ink)' : 'color:var(--muted)'}>{unitCounts[unit.name] ?? 0}</span>
							</button>
							<button
								type="button"
								onclick={() => deleteTarget = { type: 'unit', id: unit.id, name: unit.name }}
								aria-label={t('action.delete')}
								class="px-2 py-1.5 hover:opacity-70"
								style="color:var(--muted)"
							>×</button>
						</div>
					{/each}
				</div>
				{#if showNewUnit}
					<div class="border-t p-3" style="border-color:var(--line-2)">
						<form method="POST" action="?/createUnit" class="flex flex-col gap-2" use:enhance={() => {
							savingUnit = true;
							return async ({ result, update }) => {
								savingUnit = false;
								if (result.type === 'success') { showNewUnit = false; toast(t('toast.unitCreated')); }
								else if (result.type === 'failure') toast(String((result.data as Record<string, unknown>)?.error ?? t('toast.error')), 'error');
								await update();
							};
						}}>
							<Input name="name" label={t('label.unitName')} required />
							<div class="flex justify-end gap-2">
								<Btn variant="ghost" size="sm" onclick={() => showNewUnit = false}>{t('action.cancel')}</Btn>
								<Btn variant="primary" size="sm" type="submit" loading={savingUnit}>{t('action.create')}</Btn>
							</div>
						</form>
					</div>
				{/if}
			</Card>
		</div>

		<div class="lg:col-span-9">
			<Card padding={0}>
				<div
					class="flex flex-wrap items-center gap-2 border-b px-4 py-3"
					style="border-color:var(--line-2)"
				>
					<input
						type="search"
						bind:value={catalogSearch}
						placeholder={t('search.placeholder')}
						aria-label={t('search.placeholder')}
						class="rounded-md border px-2.5 py-1.5 text-[12px] focus:outline-none focus:ring-2 focus:ring-[var(--brand)]"
						style="background:#fbfcfd;border-color:var(--line);color:var(--ink);min-width:220px"
					/>
					{#if activeUnitFilter}
						<Tag tone="brand">{activeUnitFilter}</Tag>
					{/if}
					<span class="ml-auto text-[11.5px]" style="color:var(--muted)">
						{filteredCatalogItems.length} / {data.catalogItems.length}
					</span>
				</div>

				{#if showNewItem}
					<div class="border-b p-4" style="border-color:var(--line-2);background:#fbfcfd">
						<form method="POST" action="?/createItem" use:enhance={({ formData }) => {
							formData.set('unitPrice', String(newItemPrice));
							formData.set('description', newItemDescription);
							savingItem = true;
							return async ({ result, update }) => {
								savingItem = false;
								if (result.type === 'success') { showNewItem = false; newItemPrice = 0; newItemDescription = ''; toast(t('toast.itemCreated')); }
								else if (result.type === 'failure') toast(String((result.data as Record<string, unknown>)?.error ?? t('toast.error')), 'error');
								await update();
							};
						}}>
							<h3 class="mb-3 text-[12.5px] font-semibold" style="color:var(--ink)">{t('section.newItem')}</h3>
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
							<div class="mt-3 flex justify-end gap-2">
								<Btn variant="ghost" size="sm" onclick={() => showNewItem = false}>{t('action.cancel')}</Btn>
								<Btn variant="primary" size="sm" type="submit" loading={savingItem}>{t('action.create')}</Btn>
							</div>
						</form>
					</div>
				{/if}

				{#if data.catalogItems.length === 0 && !showNewItem}
					<div class="px-4 py-8 text-center text-[12px]" style="color:var(--muted)">
						{t('empty.noCatalogItems')}
					</div>
				{:else}
					<div class="divide-y" style="border-color:var(--line-2)">
						{#each filteredCatalogItems as item (item.id)}
							{#if editingId === item.id}
								<form method="POST" action="?/updateItem" class="px-4 py-4" style="background:#fbfcfd" use:enhance={({ formData }) => {
									formData.set('unitPrice', String(editItemPrice));
									formData.set('description', editItemDescription);
									savingEdit = true;
									return async ({ result, update }) => {
										savingEdit = false;
										if (result.type === 'success') { editingId = null; toast(t('toast.itemUpdated')); }
										else if (result.type === 'failure') toast(String((result.data as Record<string, unknown>)?.error ?? t('toast.error')), 'error');
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
									<div class="mt-3 flex items-center justify-end gap-2">
										<Btn variant="ghost" size="sm" onclick={() => editingId = null}>{t('action.cancel')}</Btn>
										<button
											type="button"
											class="text-[11.5px] underline hover:no-underline"
											style="color:var(--bad)"
											onclick={() => { editingId = null; deleteTarget = { type: 'item', id: item.id, name: item.name }; }}
										>{t('action.delete')}</button>
										<Btn variant="primary" size="sm" type="submit" loading={savingEdit}>{t('action.save')}</Btn>
									</div>
								</form>
							{:else}
								<button
									type="button"
									class="flex w-full items-center justify-between px-4 py-3 text-left transition-colors hover:bg-[#fbfcfd]"
									onclick={() => startEdit(item)}
								>
									<div class="min-w-0 flex-1">
										<div class="text-[12.5px] font-semibold" style="color:var(--ink)">{item.name}</div>
										{#if item.description}
											<p class="mt-0.5 truncate text-[11px]" style="color:var(--muted)">{item.description.replace(/<[^>]*>/g, ' ').trim().substring(0, 120)}</p>
										{/if}
									</div>
									<div class="ml-4 flex shrink-0 items-center gap-3">
										{#if item.unit}<Tag>{item.unit}</Tag>{/if}
										<span class="num text-[12.5px] font-medium tabular-nums" style="color:var(--ink)">{formatMoney(item.unitPrice, data.currency)}</span>
										{#if item.taxRate > 0}
											<span class="num text-[11px]" style="color:var(--muted)">{item.taxRate}%</span>
										{/if}
										<span aria-hidden="true" style="color:var(--muted)"><MoreHorizontal size={14} strokeWidth={1.6} /></span>
									</div>
								</button>
							{/if}
						{/each}
						{#if filteredCatalogItems.length === 0 && data.catalogItems.length > 0}
							<div class="px-4 py-8 text-center text-[12px]" style="color:var(--muted)">{t('search.noResults')}</div>
						{/if}
					</div>
				{/if}
			</Card>
		</div>
	</div>
</div>

{#if deleteTarget}
	<ConfirmDialog
		open={true}
		title={t('dialog.deleteCatalogItem', { type: deleteTarget.type === 'item' ? t('misc.item') : t('misc.unit') })}
		message={t('dialog.deleteCatalogItemMessage', { name: deleteTarget.name })}
		confirmLabel={t('action.delete')}
		busy={deleting}
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
	deleting = true;
	return async ({ result, update }) => {
		deleting = false;
		if (result.type === 'success') toast(t('toast.itemDeleted'));
		else if (result.type === 'failure') toast(String((result.data as Record<string, unknown>)?.error ?? t('toast.failedDelete')), 'error');
		await update();
	};
}}>
	<input bind:this={deleteItemInput} name="id" type="hidden" />
</form>

<form bind:this={deleteUnitForm} method="POST" action="?/deleteUnit" class="hidden" use:enhance={() => {
	deleting = true;
	return async ({ result, update }) => {
		deleting = false;
		if (result.type === 'success') toast(t('toast.unitDeleted'));
		else if (result.type === 'failure') toast(String((result.data as Record<string, unknown>)?.error ?? t('toast.failedDelete')), 'error');
		await update();
	};
}}>
	<input bind:this={deleteUnitInput} name="id" type="hidden" />
</form>
