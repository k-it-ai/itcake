<script lang="ts">
	import { goto, invalidateAll } from '$app/navigation';
	import { page } from '$app/state';
	import TopBar from '$components/layout/TopBar.svelte';
	import Button from '$components/ui/Button.svelte';
	import Card from '$components/ui/Card.svelte';
	import DataTable from '$components/ui/DataTable.svelte';
	import SearchInput from '$components/ui/SearchInput.svelte';
	import EmptyState from '$components/ui/EmptyState.svelte';
	import ConfirmDialog from '$components/ui/ConfirmDialog.svelte';
	import InvoiceStatusBadge from '$components/invoice/InvoiceStatusBadge.svelte';
	import { toast } from '$components/ui/Toast.svelte';
	import { formatMoney } from '$lib/money.js';
	import { formatDate } from '$lib/format-date.js';
	import { t } from '$lib/i18n/index.svelte.js';
	import type { Invoice, InvoiceStatus } from '$lib/types.js';
	import type { PageData } from './$types.js';

	let { data }: { data: PageData } = $props();
	let togglingId = $state<string | null>(null);
	let showUnpaidConfirm = $state(false);
	let unpaidTargetInvoice = $state<Invoice | null>(null);

	const dateFormat = data.settings?.general?.dateFormat || 'DD/MM/YYYY';

	async function doTogglePaidStatus(inv: Invoice, newStatus: 'paid' | 'sent') {
		togglingId = inv.id;
		try {
			const res = await fetch(`/api/invoices/${inv.id}/status`, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ status: newStatus })
			});
			if (res.ok) {
				toast(newStatus === 'paid' ? t('toast.markedAsPaid') : t('toast.markedAsUnpaid'));
				await invalidateAll();
			} else {
				const data = await res.json().catch(() => ({}));
				toast(data.message || t('toast.failedUpdateStatus'), 'error');
			}
		} catch { toast(t('toast.failedUpdateStatus'), 'error'); }
		togglingId = null;
	}

	function togglePaidStatus(inv: Invoice, e: Event) {
		e.stopPropagation();
		if (inv.status === 'paid') {
			// Reversing paid→sent has accounting implications — confirm first
			unpaidTargetInvoice = inv;
			showUnpaidConfirm = true;
		} else {
			doTogglePaidStatus(inv, 'paid');
		}
	}

	let search = $state('');
	let statusFilter = $state<InvoiceStatus | ''>((page.url.searchParams.get('status') as InvoiceStatus) || '');
	let clientFilter = $state('');
	let dateFrom = $state('');
	let dateTo = $state('');
	let exporting = $state(false);

	async function handleExport() {
		exporting = true;
		try {
			const ids = filteredInvoices.map((inv) => inv.id);
			const res = await fetch('/api/invoices/export', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ ids })
			});
			if (!res.ok) { toast(t('toast.exportFailed'), 'error'); return; }
			const failed = parseInt(res.headers.get('X-Export-Failed') ?? '0', 10);
			if (failed > 0) toast(t('toast.exportPartialFailed', { count: failed }), 'error');
			const blob = await res.blob();
			const url = URL.createObjectURL(blob);
			const a = document.createElement('a');
			a.href = url;
			a.download = ids.length === 1 ? `invoice.pdf` : `invoices-export.zip`;
			a.click();
			setTimeout(() => URL.revokeObjectURL(url), 10_000);
		} catch {
			toast(t('toast.exportFailed'), 'error');
		} finally {
			exporting = false;
		}
	}

	const statusDefs: { value: InvoiceStatus | ''; tKey: string }[] = [
		{ value: '', tKey: 'status.all' },
		{ value: 'draft', tKey: 'status.draft' },
		{ value: 'sent', tKey: 'status.sent' },
		{ value: 'paid', tKey: 'status.paid' },
		{ value: 'overdue', tKey: 'status.overdue' },
		{ value: 'cancelled', tKey: 'status.cancelled' },
	];

	// Extract unique client names from invoices
	let clientOptions = $derived.by(() => {
		const names = [...new Set((data.invoices as Invoice[]).map((inv) => inv.buyer?.name ?? ''))].filter(Boolean).sort();
		return [{ value: '', label: t('invoice.allClients') }, ...names.map((n) => ({ value: n, label: n }))];
	});

	let columns = $derived([
		{ key: 'documentId', label: t('invoice.number'), sortable: true },
		{ key: 'buyer', label: t('invoice.client'), sortable: true },
		{ key: 'issueDate', label: t('invoice.date'), sortable: true },
		{ key: 'dueDate', label: t('invoice.dueDate'), sortable: true },
		{ key: 'total', label: t('invoice.amount'), sortable: true, class: 'text-right' },
		{ key: 'status', label: t('invoice.status') },
	]);

	let filteredInvoices = $derived.by(() => {
		let result = data.invoices as Invoice[];
		if (statusFilter) result = result.filter((inv) => inv.status === statusFilter);
		if (clientFilter) result = result.filter((inv) => inv.buyer?.name === clientFilter);
		if (search) {
			const q = search.toLowerCase();
			result = result.filter((inv) =>
				inv.documentId.toLowerCase().includes(q) ||
				(inv.buyer?.name ?? '').toLowerCase().includes(q)
			);
		}
		if (dateFrom) result = result.filter((inv) => inv.issueDate >= dateFrom);
		if (dateTo) result = result.filter((inv) => inv.issueDate <= dateTo);
		return result;
	});

	let hasFilters = $derived(statusFilter !== '' || clientFilter !== '' || dateFrom !== '' || dateTo !== '' || search !== '');

	// Sync statusFilter to URL for bookmarkable/shareable filter state
	$effect(() => {
		const url = new URL(window.location.href);
		if (statusFilter) {
			url.searchParams.set('status', statusFilter);
		} else {
			url.searchParams.delete('status');
		}
		if (url.href !== window.location.href) {
			window.history.replaceState({}, '', url);
		}
	});
</script>

<svelte:head><title>{t('invoice.titlePlural')} | ITCake</title></svelte:head>

<TopBar title={t('invoice.titlePlural')}>
	{#snippet children()}
		<div class="flex gap-2">
			{#if data.invoices.length > 0}
				<Button variant="secondary" size="sm" loading={exporting} onclick={handleExport}>{hasFilters ? t('export.pdfCount', { count: filteredInvoices.length }) : t('export.pdf')}</Button>
			{/if}
			<Button onclick={() => goto('/invoices/new')}>+ {t('invoice.new')}</Button>
		</div>
	{/snippet}
</TopBar>

<div class="p-6">
	{#if data.invoices.length === 0}
		<Card>
			<EmptyState title={t('dashboard.noInvoices')} description={t('empty.createFirstInvoice')}>
				{#snippet children()}
					<Button onclick={() => goto('/invoices/new')}>+ {t('invoice.new')}</Button>
				{/snippet}
			</EmptyState>
		</Card>
	{:else}
		<Card flush>
			<!-- Filter bar -->
			<div class="flex flex-col gap-3 p-3 border-b border-border sm:flex-row sm:flex-wrap sm:items-center sm:p-4">
				<div class="flex items-center gap-2 w-full sm:w-auto">
					<SearchInput bind:value={search} placeholder={t('search.placeholder')} class="flex-1 sm:max-w-[200px]" />
					<select bind:value={clientFilter} aria-label={t('label.filterByClient')}
						class="rounded-lg border border-border bg-input-bg text-near-black px-2.5 py-2 text-xs focus:border-cyan focus:outline-none focus:ring-1 focus:ring-cyan">
						{#each clientOptions as opt}
							<option value={opt.value}>{opt.label}</option>
						{/each}
					</select>
				</div>

				<div class="flex gap-1 overflow-x-auto" role="radiogroup" tabindex="-1" aria-label={t('label.filterByStatus')}
					onkeydown={(e: KeyboardEvent) => {
						if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
						e.preventDefault();
						const btns = (e.currentTarget as HTMLElement).querySelectorAll<HTMLButtonElement>('[role="radio"]');
						const idx = Array.from(btns).findIndex(b => b === document.activeElement);
						const next = e.key === 'ArrowRight' ? (idx + 1) % btns.length : (idx - 1 + btns.length) % btns.length;
						btns[next].focus();
						btns[next].click();
					}}>
					{#each statusDefs as s}
						<button
							class="whitespace-nowrap px-3 py-2.5 sm:py-1.5 rounded-full text-xs font-medium transition-colors
								{statusFilter === s.value ? 'bg-cyan text-white' : 'bg-bg text-near-black/60 hover:text-near-black'}"
							onclick={() => statusFilter = s.value}
							role="radio"
							aria-checked={statusFilter === s.value}
							tabindex={statusFilter === s.value ? 0 : -1}
						>{t(s.tKey)}</button>
					{/each}
				</div>

				<div class="flex items-center gap-2 sm:ml-auto">
					<input type="date" bind:value={dateFrom} aria-label={t('label.fromDate')} class="flex-1 sm:flex-none rounded border border-border bg-input-bg text-near-black px-2 py-1 text-xs focus:border-cyan focus:outline-none" />
					<span class="text-xs text-near-black/60">–</span>
					<input type="date" bind:value={dateTo} aria-label={t('label.toDate')} class="flex-1 sm:flex-none rounded border border-border bg-input-bg text-near-black px-2 py-1 text-xs focus:border-cyan focus:outline-none" />
					{#if hasFilters}
						<button class="text-xs text-red hover:text-red-dark whitespace-nowrap" onclick={() => { search = ''; statusFilter = ''; clientFilter = ''; dateFrom = ''; dateTo = ''; }}>{t('action.clearFilters')}</button>
					{/if}
				</div>
			</div>

			<DataTable
				{columns}
				data={filteredInvoices}
				onrowclick={(inv) => goto(`/invoices/${inv.id}`)}
			>
				{#snippet row(inv: Invoice)}
					<td class="px-4 py-3 font-medium text-near-black">
					{inv.documentId}
					{#if inv.invoiceType === 'creditNote'}
						<span class="ml-1 inline-flex items-center rounded-full bg-amber-100 dark:bg-amber-900/30 px-1.5 py-0.5 text-xs font-medium text-amber-800 dark:text-amber-300" title={t('badge.creditNote')}>{t('badge.creditNoteBadge')}</span>
					{/if}
					{#if inv.recurring?.enabled}
						<span class="ml-1 inline-flex items-center rounded-full bg-cyan/10 px-1.5 py-0.5 text-xs font-medium text-cyan" title="Recurring: {inv.recurring.frequency}">
							<svg class="mr-0.5 h-3 w-3" fill="none" stroke="currentColor" viewBox="0 0 24 24" stroke-width="2"><path stroke-linecap="round" stroke-linejoin="round" d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" /></svg>
						</span>
					{/if}
				</td>
					<td class="px-4 py-3 text-near-black/70">{inv.buyer?.name ?? ''}</td>
					<td class="px-4 py-3 text-near-black/70">{formatDate(inv.issueDate, dateFormat)}</td>
					<td class="px-4 py-3 text-near-black/70">{inv.dueDate ? formatDate(inv.dueDate, dateFormat) : ''}</td>
					<td class="px-4 py-3 text-right font-medium tabular-nums">{formatMoney(inv.totals.total, inv.currency)}</td>
					<td class="px-4 py-3">
						<div class="flex items-center gap-2">
							<InvoiceStatusBadge status={inv.status} />
							{#if inv.status === 'sent' || inv.status === 'overdue' || inv.status === 'paid'}
								<button
									onclick={(e) => togglePaidStatus(inv, e)}
									disabled={togglingId === inv.id}
									class="text-xs rounded px-2 py-1 border transition-colors
										{inv.status === 'paid'
											? 'border-cyan/30 text-cyan hover:bg-cyan/5'
											: 'border-near-black/20 text-near-black/60 hover:bg-bg'}"
									title={inv.status === 'paid' ? t('action.markAsUnpaid') : t('action.markAsPaid')}
								>
									{#if togglingId === inv.id}
										<span class="inline-block h-3 w-3 animate-spin rounded-full border border-current border-t-transparent"></span>
									{:else}
										{inv.status === 'paid' ? `✓ ${t('status.paid')}` : t('action.markAsPaid')}
									{/if}
								</button>
							{/if}
						</div>
					</td>
				{/snippet}
			</DataTable>
		</Card>
	{/if}
</div>

<ConfirmDialog
	open={showUnpaidConfirm}
	title={t('dialog.confirmUnpaid')}
	message={t('dialog.confirmUnpaidMessage')}
	confirmLabel={t('action.markAsUnpaid')}
	variant="danger"
	onconfirm={() => {
		showUnpaidConfirm = false;
		if (unpaidTargetInvoice) doTogglePaidStatus(unpaidTargetInvoice, 'sent');
		unpaidTargetInvoice = null;
	}}
	oncancel={() => { showUnpaidConfirm = false; unpaidTargetInvoice = null; }}
/>
