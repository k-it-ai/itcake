<script lang="ts">
	import { enhance } from '$app/forms';
	import TopBar from '$components/layout/TopBar.svelte';
	import Button from '$components/ui/Button.svelte';
	import Card from '$components/ui/Card.svelte';
	import Input from '$components/ui/Input.svelte';
	import Select from '$components/ui/Select.svelte';
	import SearchInput from '$components/ui/SearchInput.svelte';
	import MoneyInput from '$components/ui/MoneyInput.svelte';
	import Badge from '$components/ui/Badge.svelte';
	import EmptyState from '$components/ui/EmptyState.svelte';
	import ConfirmDialog from '$components/ui/ConfirmDialog.svelte';
	import { toast } from '$components/ui/Toast.svelte';
	import { formatMoney } from '$lib/money.js';
	import { formatDate } from '$lib/format-date.js';
	import { t } from '$lib/i18n/index.svelte.js';
	import type { PageData, ActionData } from './$types.js';
	import type { Expense, ExpenseCategory } from '$lib/types.js';

	let { data, form }: { data: PageData; form: ActionData } = $props();

	let showNew = $state(false);
	let editingId = $state<string | null>(null);
	let deleteTarget = $state<{ id: string; description: string } | null>(null);
	let categoryFilter = $state('');
	let search = $state('');
	let dateFrom = $state('');
	let dateTo = $state('');

	// Form state for new expense
	let newAmount = $state(0);
	let newTaxAmount = $state(0);

	// Form state for editing
	let editAmount = $state(0);
	let editTaxAmount = $state(0);

	const categoryOptions = [
		{ value: '', label: t('label.allCategories') },
		...data.categories.map(c => ({ value: c, label: t(`category.${c}`) }))
	];

	const categorySelectOptions = data.categories.map(c => ({ value: c, label: t(`category.${c}`) }));
	const categoryLabels: Record<string, string> = Object.fromEntries(data.categories.map(c => [c, t(`category.${c}`)]));

	let hasFilters = $derived(search !== '' || categoryFilter !== '' || dateFrom !== '' || dateTo !== '');

	let filteredExpenses = $derived(
		data.expenses.filter(e => {
			if (categoryFilter && e.category !== categoryFilter) return false;
			if (dateFrom && e.date < dateFrom) return false;
			if (dateTo && e.date > dateTo) return false;
			if (search) {
				const q = search.toLowerCase();
				return e.description.toLowerCase().includes(q) || e.vendor.toLowerCase().includes(q);
			}
			return true;
		})
	);

	let totalFiltered = $derived(filteredExpenses.reduce((sum, e) => sum + e.amount, 0));

	function startEdit(expense: Expense) {
		editingId = expense.id;
		editAmount = expense.amount;
		editTaxAmount = expense.taxAmount;
		showNew = false;
	}

	function resetNew() {
		showNew = true;
		editingId = null;
		newAmount = 0;
		newTaxAmount = 0;
	}

	let deleteForm = $state<HTMLFormElement>();
	let deleteInput = $state<HTMLInputElement>();
</script>

<svelte:head><title>{t('expense.titlePlural')} | ITCake</title></svelte:head>

<TopBar title={t('expense.titlePlural')}>
	{#snippet children()}
		<Button size="sm" onclick={resetNew}>+ {t('expense.new')}</Button>
	{/snippet}
</TopBar>

<div class="p-6 space-y-6">
	{#if form?.error}
		<div role="alert" class="rounded-lg bg-red/10 px-4 py-3 text-sm text-red-dark dark:text-red-300">{form.error}</div>
	{/if}

	{#if showNew}
		<Card>
			<form method="POST" action="?/create" enctype="multipart/form-data" use:enhance={({ formData }) => {
				formData.set('amount', String(newAmount));
				formData.set('taxAmount', String(newTaxAmount));
				formData.set('currency', data.currency);
				return async ({ result, update }) => {
					if (result.type === 'success') {
						showNew = false; newAmount = 0; newTaxAmount = 0; toast(t('toast.expenseAdded'));
						if ((result.data as Record<string, unknown>)?.receiptError) {
							toast(String((result.data as Record<string, unknown>).receiptError), 'error');
						}
					}
					await update();
				};
			}}>
				<h2 class="text-lg font-semibold mb-4">{t('expense.new')}</h2>
				<div class="grid grid-cols-1 gap-4 sm:grid-cols-2">
					<Input name="date" type="date" label={t('expense.date')} required value={new Date().toISOString().split('T')[0]} />
					<Input name="description" label={t('expense.description')} required placeholder={t('placeholder.expenseDescription')} />
					<MoneyInput bind:value={newAmount} currency={data.currency} label={t('expense.amount')} name="amount" />
					<MoneyInput bind:value={newTaxAmount} currency={data.currency} label={t('expense.taxAmount')} name="taxAmount" />
					<Select name="category" label={t('expense.category')} options={categorySelectOptions} value="other" />
					<Input name="vendor" label={t('expense.vendor')} placeholder={t('placeholder.vendorName')} />
				</div>
				<div class="mt-4">
					<Input name="notes" label={t('invoice.notes')} placeholder={t('placeholder.additionalNotes')} />
				</div>
				<div class="mt-4">
					<label for="new-receipt" class="block text-sm font-medium text-near-black mb-1">{t('expense.receipt')}</label>
					<input id="new-receipt" name="receipt" type="file" accept="image/jpeg,image/png,image/webp,application/pdf" class="text-sm file:mr-3 file:rounded-lg file:border-0 file:bg-bg file:px-3 file:py-1.5 file:text-sm file:font-medium file:text-near-black hover:file:bg-border" />
					<p class="text-xs text-near-black/60 mt-1">{t('help.receiptFormats')}</p>
				</div>
				<div class="mt-4 flex gap-2 justify-end">
					<Button variant="secondary" size="sm" onclick={() => showNew = false}>{t('action.cancel')}</Button>
					<Button type="submit" size="sm">{t('expense.new')}</Button>
				</div>
			</form>
		</Card>
	{/if}

	{#if data.expenses.length === 0 && !showNew}
		<Card>
			<EmptyState title={t('expense.noExpenses')} description={t('empty.noExpensesDescription')}>
				{#snippet children()}
					<Button onclick={resetNew}>+ {t('expense.new')}</Button>
				{/snippet}
			</EmptyState>
		</Card>
	{:else}
		<Card flush>
			<!-- Filter bar -->
			<div class="flex flex-col gap-3 p-3 border-b border-border sm:flex-row sm:flex-wrap sm:items-center sm:p-4">
				<div class="flex items-center gap-2 w-full sm:w-auto">
					<SearchInput bind:value={search} placeholder={t('search.placeholder')} class="flex-1 sm:max-w-[200px]" />
					<select bind:value={categoryFilter} aria-label={t('label.filterByCategory')}
						class="rounded-lg border border-border bg-input-bg text-near-black px-2.5 py-2 text-xs focus:border-cyan focus:outline-none focus:ring-1 focus:ring-cyan">
						{#each categoryOptions as opt}
							<option value={opt.value}>{opt.label}</option>
						{/each}
					</select>
				</div>

				<div class="flex items-center gap-2 sm:ml-auto">
					<input type="date" bind:value={dateFrom} aria-label={t('label.fromDate')} class="flex-1 sm:flex-none rounded border border-border bg-input-bg text-near-black px-2 py-1 text-xs focus:border-cyan focus:outline-none" />
					<span class="text-xs text-near-black/60">–</span>
					<input type="date" bind:value={dateTo} aria-label={t('label.toDate')} class="flex-1 sm:flex-none rounded border border-border bg-input-bg text-near-black px-2 py-1 text-xs focus:border-cyan focus:outline-none" />
					<span class="text-xs text-near-black/60 tabular-nums whitespace-nowrap">{t('dashboard.total')}: <span class="font-semibold">{formatMoney(totalFiltered, data.currency)}</span></span>
					{#if hasFilters}
						<button class="text-xs text-red hover:text-red-dark whitespace-nowrap" onclick={() => { search = ''; categoryFilter = ''; dateFrom = ''; dateTo = ''; }}>{t('action.clearFilters')}</button>
					{/if}
				</div>
			</div>
			<div class="divide-y divide-border">
				{#if filteredExpenses.length === 0 && hasFilters}
					<p class="px-4 py-8 text-sm text-near-black/60 text-center">{t('empty.noExpensesMatchFilter')}</p>
				{/if}
				{#each filteredExpenses as expense}
					{#if editingId === expense.id}
						<form method="POST" action="?/update" enctype="multipart/form-data" class="p-4" use:enhance={({ formData }) => {
							formData.set('amount', String(editAmount));
							formData.set('taxAmount', String(editTaxAmount));
							formData.set('currency', data.currency);
							return async ({ result, update }) => {
								if (result.type === 'success') {
									editingId = null; toast(t('toast.expenseUpdated'));
									if ((result.data as Record<string, unknown>)?.receiptError) {
										toast(String((result.data as Record<string, unknown>).receiptError), 'error');
									}
								}
								await update();
							};
						}}>
							<input type="hidden" name="id" value={expense.id} />
							<div class="grid grid-cols-1 gap-3 sm:grid-cols-2">
								<Input name="date" type="date" label={t('expense.date')} required value={expense.date} />
								<Input name="description" label={t('expense.description')} required value={expense.description} />
								<MoneyInput bind:value={editAmount} currency={data.currency} label={t('expense.amount')} name="amount" />
								<MoneyInput bind:value={editTaxAmount} currency={data.currency} label={t('expense.taxAmount')} name="taxAmount" />
								<Select name="category" label={t('expense.category')} options={categorySelectOptions} value={expense.category} />
								<Input name="vendor" label={t('expense.vendor')} value={expense.vendor} />
							</div>
							<div class="mt-3">
								<Input name="notes" label={t('invoice.notes')} value={expense.notes} />
							</div>
							<div class="mt-3">
								<label for="edit-receipt-{expense.id}" class="block text-sm font-medium text-near-black mb-1">{t('expense.receipt')}</label>
								{#if expense.receiptFilename}
									<a href="/api/receipts?file={encodeURIComponent(expense.receiptFilename)}" target="_blank" class="text-xs text-cyan hover:text-cyan-dark">{t('expense.receipt')}</a>
								{/if}
								<input id="edit-receipt-{expense.id}" name="receipt" type="file" accept="image/jpeg,image/png,image/webp,application/pdf" class="text-sm mt-1 file:mr-3 file:rounded-lg file:border-0 file:bg-bg file:px-3 file:py-1.5 file:text-sm file:font-medium file:text-near-black hover:file:bg-border" />
							</div>
							<div class="mt-3 flex gap-2 justify-end">
								<Button variant="secondary" size="sm" onclick={() => editingId = null}>{t('action.cancel')}</Button>
								<button type="button" class="text-xs text-red hover:text-red-dark px-2" onclick={() => { editingId = null; deleteTarget = { id: expense.id, description: expense.description }; }}>{t('action.delete')}</button>
								<Button type="submit" size="sm">{t('action.save')}</Button>
							</div>
						</form>
					{:else}
						<button
							type="button"
							class="flex w-full items-center justify-between px-4 py-3 text-left hover:bg-bg/50 transition-colors"
							onclick={() => startEdit(expense)}
						>
							<div class="min-w-0 flex-1">
								<div class="flex items-center gap-2">
									<span class="text-sm font-medium text-near-black">{expense.description}</span>
									<Badge variant="default">{categoryLabels[expense.category] ?? expense.category}</Badge>
									{#if expense.receiptFilename}
										<svg class="h-3.5 w-3.5 text-cyan" fill="none" stroke="currentColor" viewBox="0 0 24 24" stroke-width="1.5" aria-label="Has receipt"><path stroke-linecap="round" stroke-linejoin="round" d="M15.172 7l-6.586 6.586a2 2 0 102.828 2.828l6.414-6.586a4 4 0 00-5.656-5.656l-6.415 6.585a6 6 0 108.486 8.486L20.5 13" /></svg>
									{/if}
								</div>
								<p class="text-xs text-near-black/60 mt-0.5">
									{formatDate(expense.date, data.dateFormat)}{expense.vendor ? ` · ${expense.vendor}` : ''}
								</p>
							</div>
							<span class="text-sm font-medium tabular-nums ml-4">{formatMoney(expense.amount, expense.currency)}</span>
						</button>
					{/if}
				{/each}
			</div>
		</Card>
	{/if}
</div>

{#if deleteTarget}
	<ConfirmDialog
		open={true}
		title={t('dialog.deleteExpense')}
		message={t('dialog.deleteExpenseMessage', { description: deleteTarget.description })}
		confirmLabel={t('action.delete')}
		onconfirm={() => {
			if (!deleteTarget || !deleteInput || !deleteForm) return;
			deleteInput.value = deleteTarget.id;
			deleteForm.requestSubmit();
			deleteTarget = null;
		}}
		oncancel={() => deleteTarget = null}
	/>
{/if}

<form bind:this={deleteForm} method="POST" action="?/delete" class="hidden" use:enhance={() => {
	return async ({ result, update }) => {
		if (result.type === 'success') toast(t('toast.expenseDeleted'));
		await update();
	};
}}>
	<input bind:this={deleteInput} name="id" type="hidden" />
</form>
