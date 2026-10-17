<script lang="ts">
	import { enhance } from '$app/forms';
	import TopBar from '#lib/components/shell/TopBar.svelte';
	import Btn from '#lib/components/ui/Btn.svelte';
	import Card from '#lib/components/ui/Card.svelte';
	import SectionHead from '#lib/components/ui/SectionHead.svelte';
	import Tag from '#lib/components/ui/Tag.svelte';
	import EmptyState from '#lib/components/ui/EmptyState.svelte';
	import Input from '#components/ui/Input.svelte';
	import Select from '#components/ui/Select.svelte';
	import MoneyInput from '#components/ui/MoneyInput.svelte';
	import ConfirmDialog from '#components/ui/ConfirmDialog.svelte';
	import { toast } from '#components/ui/Toast.svelte';
	import { Plus, Paperclip, MoreHorizontal } from '#lib/icons/index.js';
	import { formatMoney } from '#lib/money.js';
	import { formatDate } from '#lib/format-date.js';
	import { t } from '#lib/i18n/index.svelte.js';
	import type { PageData, ActionData } from './$types.js';
	import type { Expense } from '#lib/types.js';

	let { data, form }: { data: PageData; form: ActionData } = $props();

	import { goto } from '$app/navigation';
	import { page as pageStore } from '$app/state';

	let showNew = $state(false);
	let editingId = $state<string | null>(null);
	let deleteTarget = $state<{ id: string; description: string } | null>(null);

	let categoryFilter = $state(data.filters.category);
	let search = $state(data.filters.search);
	let dateFrom = $state(data.filters.dateFrom);
	let dateTo = $state(data.filters.dateTo);

	let newAmount = $state(0);
	let newTaxAmount = $state(0);

	let editAmount = $state(0);
	let editTaxAmount = $state(0);

	const categoryOptions = [
		{ value: '', label: t('label.allCategories') },
		...data.categories.map(c => ({ value: c, label: t(`category.${c}`) }))
	];

	const categorySelectOptions = data.categories.map(c => ({ value: c, label: t(`category.${c}`) }));
	const categoryLabels: Record<string, string> = Object.fromEntries(data.categories.map(c => [c, t(`category.${c}`)]));

	let hasFilters = $derived(search !== '' || categoryFilter !== '' || dateFrom !== '' || dateTo !== '');

	let totalFiltered = $derived(data.expenses.reduce((sum, e) => sum + e.amount, 0));
	let totalVat = $derived(data.expenses.reduce((sum, e) => sum + e.taxAmount, 0));
	let withReceipt = $derived(data.expenses.filter((e) => e.receiptFilename).length);
	let missingReceipt = $derived(data.expenses.length - withReceipt);

	let searchTimer: ReturnType<typeof setTimeout>;

	function clearFilters() {
		search = ''; categoryFilter = ''; dateFrom = ''; dateTo = '';
		goto('/expenses', { replaceState: true });
	}

	function applyFilters() {
		const url = new URL(pageStore.url.href);
		url.searchParams.delete('page');
		if (categoryFilter) url.searchParams.set('category', categoryFilter); else url.searchParams.delete('category');
		if (search) url.searchParams.set('q', search); else url.searchParams.delete('q');
		if (dateFrom) url.searchParams.set('from', dateFrom); else url.searchParams.delete('from');
		if (dateTo) url.searchParams.set('to', dateTo); else url.searchParams.delete('to');
		goto(url.toString(), { replaceState: true });
	}

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

<TopBar
	title={t('expense.titlePlural')}
	breadcrumb={[t('crumb.billing'), t('expense.titlePlural')]}
	sub={`${data.total} ${t('expense.titlePlural').toLowerCase()} · ${formatMoney(totalFiltered, data.currency)}`}
>
	{#snippet right()}
		<Btn variant="primary" size="sm" onclick={resetNew}>
			{#snippet icon()}<Plus size={14} strokeWidth={1.6} />{/snippet}
			{t('expense.new')}
		</Btn>
	{/snippet}
</TopBar>

<div class="p-5 space-y-4">
	{#if form?.error}
		<div role="alert" class="rounded-md px-3 py-2 text-[12.5px]" style="background:var(--bad-soft);color:#7a1a22">{form.error}</div>
	{/if}

	<!-- Stat row -->
	<div class="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
		<Card padding={14}>
			<p class="text-[11px]" style="color:var(--muted)">{t('dashboard.total')}</p>
			<p class="num mt-1 text-[20px] font-semibold tracking-tight" style="color:var(--ink)">{formatMoney(totalFiltered, data.currency)}</p>
		</Card>
		<Card padding={14}>
			<p class="text-[11px]" style="color:var(--muted)">{t('expense.taxAmount')}</p>
			<p class="num mt-1 text-[20px] font-semibold tracking-tight" style="color:var(--ink)">{formatMoney(totalVat, data.currency)}</p>
		</Card>
		<Card padding={14}>
			<p class="text-[11px]" style="color:var(--muted)">{t('expense.receipt')}</p>
			<p class="num mt-1 text-[20px] font-semibold tracking-tight" style="color:var(--ink)">
				{withReceipt}<span class="text-[14px] font-normal" style="color:var(--muted)"> / {data.expenses.length}</span>
			</p>
			{#if missingReceipt > 0}
				<div class="mt-1"><Tag tone="warn">{missingReceipt} missing</Tag></div>
			{/if}
		</Card>
		<Card padding={14}>
			<p class="text-[11px]" style="color:var(--muted)">{t('expense.category')}</p>
			<p class="num mt-1 text-[20px] font-semibold tracking-tight" style="color:var(--ink)">{data.categories.length}</p>
		</Card>
	</div>

	{#if showNew}
		<Card padding={20}>
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
				<SectionHead title={t('expense.new')} />
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
					<label for="new-receipt" class="mb-1 block text-[12px] font-medium" style="color:var(--ink)">{t('expense.receipt')}</label>
					<input id="new-receipt" name="receipt" type="file" accept="image/jpeg,image/png,image/webp,application/pdf" class="text-[12px] file:mr-3 file:rounded-md file:border-0 file:bg-[var(--brand-soft)] file:px-3 file:py-1.5 file:text-[12px] file:font-medium hover:file:opacity-90" style="color:var(--ink)" />
					<p class="mt-1 text-[11px]" style="color:var(--muted)">{t('help.receiptFormats')}</p>
				</div>
				<div class="mt-4 flex justify-end gap-2">
					<Btn variant="ghost" size="sm" onclick={() => showNew = false}>{t('action.cancel')}</Btn>
					<Btn variant="primary" size="sm" type="submit">{t('expense.new')}</Btn>
				</div>
			</form>
		</Card>
	{/if}

	{#if data.expenses.length === 0 && !showNew && !hasFilters}
		<Card>
			<EmptyState title={t('expense.noExpenses')} description={t('empty.noExpensesDescription')}>
				{#snippet actions()}
					<Btn variant="primary" size="sm" onclick={resetNew}>
						{#snippet icon()}<Plus size={14} strokeWidth={1.6} />{/snippet}
						{t('expense.new')}
					</Btn>
				{/snippet}
			</EmptyState>
		</Card>
	{:else}
		<Card padding={0}>
			<div
				class="flex flex-wrap items-center gap-2 border-b px-4 py-3"
				style="border-color:var(--line-2)"
			>
				<input
					type="search"
					bind:value={search}
					placeholder={t('search.placeholder')}
					aria-label={t('search.placeholder')}
					oninput={() => { clearTimeout(searchTimer); searchTimer = setTimeout(applyFilters, 400); }}
					class="rounded-md border px-2.5 py-1.5 text-[12px] focus:outline-none focus:ring-2 focus:ring-[var(--brand)]"
					style="background:#fbfcfd;border-color:var(--line);color:var(--ink);min-width:220px"
				/>
				<select
					bind:value={categoryFilter}
					aria-label={t('label.filterByCategory')}
					onchange={() => applyFilters()}
					class="rounded-md border px-2.5 py-1.5 text-[12px] focus:outline-none focus:ring-2 focus:ring-[var(--brand)]"
					style="background:#fbfcfd;border-color:var(--line);color:var(--ink)"
				>
					{#each categoryOptions as opt (opt.value)}
						<option value={opt.value}>{opt.label}</option>
					{/each}
				</select>
				<input
					type="date"
					bind:value={dateFrom}
					aria-label={t('label.fromDate')}
					onchange={() => applyFilters()}
					class="rounded-md border px-2 py-1.5 text-[12px] focus:outline-none focus:ring-2 focus:ring-[var(--brand)]"
					style="background:#fbfcfd;border-color:var(--line);color:var(--ink)"
				/>
				<span class="text-[11px]" style="color:var(--muted)">–</span>
				<input
					type="date"
					bind:value={dateTo}
					aria-label={t('label.toDate')}
					onchange={() => applyFilters()}
					class="rounded-md border px-2 py-1.5 text-[12px] focus:outline-none focus:ring-2 focus:ring-[var(--brand)]"
					style="background:#fbfcfd;border-color:var(--line);color:var(--ink)"
				/>
				<span class="ml-auto text-[11.5px]" style="color:var(--muted)">
					{data.expenses.length} · <span class="font-semibold" style="color:var(--ink)">{formatMoney(totalFiltered, data.currency)}</span>
				</span>
				{#if hasFilters}
					<button
						class="text-[12px] underline hover:no-underline"
						style="color:var(--bad)"
						onclick={clearFilters}
					>{t('action.clearFilters')}</button>
				{/if}
			</div>

			<div class="overflow-x-auto">
				<table class="w-full text-[12.5px] num">
					<thead>
						<tr style="border-bottom:1px solid var(--line-2)">
							<th class="px-4 py-2 text-left text-[10.5px] font-medium uppercase tracking-wide" style="color:var(--muted)">{t('expense.date')}</th>
							<th class="px-4 py-2 text-left text-[10.5px] font-medium uppercase tracking-wide" style="color:var(--muted)">{t('expense.description')}</th>
							<th class="px-4 py-2 text-left text-[10.5px] font-medium uppercase tracking-wide" style="color:var(--muted)">{t('expense.category')}</th>
							<th class="px-4 py-2 text-left text-[10.5px] font-medium uppercase tracking-wide" style="color:var(--muted)">{t('expense.vendor')}</th>
							<th class="px-4 py-2 text-right text-[10.5px] font-medium uppercase tracking-wide" style="color:var(--muted)">{t('expense.amount')}</th>
							<th class="px-4 py-2 text-right text-[10.5px] font-medium uppercase tracking-wide" style="color:var(--muted)">{t('expense.taxAmount')}</th>
							<th class="px-4 py-2 text-left text-[10.5px] font-medium uppercase tracking-wide" style="color:var(--muted)">{t('expense.receipt')}</th>
							<th class="w-8 px-2 py-2"></th>
						</tr>
					</thead>
					<tbody>
						{#if data.expenses.length === 0 && hasFilters}
							<tr><td colspan="8" class="px-4 py-8 text-center text-[12px]" style="color:var(--muted)">{t('empty.noExpensesMatchFilter')}</td></tr>
						{/if}
						{#each data.expenses as expense (expense.id)}
							{#if editingId === expense.id}
								<tr>
									<td colspan="8" class="px-4 py-4" style="background:#fbfcfd">
										<form method="POST" action="?/update" enctype="multipart/form-data" use:enhance={({ formData }) => {
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
												<label for="edit-receipt-{expense.id}" class="mb-1 block text-[12px] font-medium" style="color:var(--ink)">{t('expense.receipt')}</label>
												{#if expense.receiptFilename}
													<a href="/api/receipts?file={encodeURIComponent(expense.receiptFilename)}" target="_blank" rel="noopener noreferrer" class="text-[11.5px] underline" style="color:var(--brand-ink)">{t('expense.receipt')}</a>
												{/if}
												<input id="edit-receipt-{expense.id}" name="receipt" type="file" accept="image/jpeg,image/png,image/webp,application/pdf" class="mt-1 text-[12px] file:mr-3 file:rounded-md file:border-0 file:bg-[var(--brand-soft)] file:px-3 file:py-1.5 file:text-[12px] file:font-medium hover:file:opacity-90" style="color:var(--ink)" />
											</div>
											<div class="mt-3 flex items-center justify-end gap-2">
												<Btn variant="ghost" size="sm" onclick={() => editingId = null}>{t('action.cancel')}</Btn>
												<button
													type="button"
													class="text-[11.5px] underline hover:no-underline"
													style="color:var(--bad)"
													onclick={() => { editingId = null; deleteTarget = { id: expense.id, description: expense.description }; }}
												>{t('action.delete')}</button>
												<Btn variant="primary" size="sm" type="submit">{t('action.save')}</Btn>
											</div>
										</form>
									</td>
								</tr>
							{:else}
								<tr
									class="cursor-pointer transition-colors hover:bg-[#fbfcfd]"
									style="border-top:1px solid var(--line-2)"
									onclick={() => startEdit(expense)}
								>
									<td class="px-4 py-3 num" style="font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:11px;color:var(--muted)">{formatDate(expense.date, data.dateFormat)}</td>
									<td class="px-4 py-3 font-medium" style="color:var(--ink)">{expense.description}</td>
									<td class="px-4 py-3"><Tag>{categoryLabels[expense.category] ?? expense.category}</Tag></td>
									<td class="px-4 py-3" style="color:var(--muted)">{expense.vendor || ''}</td>
									<td class="px-4 py-3 text-right tabular-nums font-medium" style="color:var(--ink)">{formatMoney(expense.amount, expense.currency)}</td>
									<td class="px-4 py-3 text-right tabular-nums" style="color:var(--muted)">{expense.taxAmount ? formatMoney(expense.taxAmount, expense.currency) : '—'}</td>
									<td class="px-4 py-3">
										{#if expense.receiptFilename}
											<span class="inline-flex items-center gap-1 text-[11.5px]" style="color:#0f5d3d">
												<Paperclip size={12} strokeWidth={1.6} aria-hidden="true" />
												PDF
											</span>
										{:else}
											<Tag tone="warn">missing</Tag>
										{/if}
									</td>
									<td class="px-2 py-3 text-right">
										<span aria-hidden="true" style="color:var(--muted)"><MoreHorizontal size={14} strokeWidth={1.6} /></span>
									</td>
								</tr>
							{/if}
						{/each}
					</tbody>
				</table>
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
