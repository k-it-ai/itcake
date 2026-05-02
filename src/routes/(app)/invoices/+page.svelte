<script lang="ts">
	import { goto, invalidateAll } from '$app/navigation';
	import TopBar from '$components/layout/TopBar.svelte';
	import Button from '$components/ui/Button.svelte';
	import Card from '$components/ui/Card.svelte';
	import DataTable from '$components/ui/DataTable.svelte';
	import SearchInput from '$components/ui/SearchInput.svelte';
	import EmptyState from '$components/ui/EmptyState.svelte';
	import ConfirmDialog from '$components/ui/ConfirmDialog.svelte';
	import Badge from '$components/ui/Badge.svelte';
	import { tick } from 'svelte';
	import { invoiceBadgeVariant } from '$lib/select-options.js';
	import { toast } from '$components/ui/Toast.svelte';
	import { formatMoney } from '$lib/money.js';
	import { formatDate } from '$lib/format-date.js';
	import { t } from '$lib/i18n/index.svelte.js';
	import type { Invoice, InvoiceStatus } from '$lib/types.js';
	import type { PageData } from './$types.js';

	let { data }: { data: PageData } = $props();
	let togglingId = $state<string | null>(null);
	let showStatusConfirm = $state(false);
	let statusConfirmInvoice = $state<Invoice | null>(null);
	let statusConfirmTarget = $state<InvoiceStatus | null>(null);
	let openStatusMenuId = $state<string | null>(null);
	let statusMenuEl = $state<HTMLDivElement>();
	let statusMenuPos = $state({ top: 0, left: 0 });

	let dateFormat = $derived(data.settings?.general?.dateFormat || 'DD/MM/YYYY');

	let searchTimer: ReturnType<typeof setTimeout> | undefined;

	function updateFilters(updates: Record<string, string>) {
		const url = new URL(window.location.href);
		for (const [key, value] of Object.entries(updates)) {
			if (value) url.searchParams.set(key, value);
			else url.searchParams.delete(key);
		}
		url.searchParams.delete('page'); // Reset to page 1 on filter change
		goto(url.pathname + url.search, { replaceState: true, keepFocus: true });
	}

	function debouncedSearch(value: string) {
		clearTimeout(searchTimer);
		searchTimer = setTimeout(() => updateFilters({ q: value }), 300);
	}

	function handlePageChange(newPage: number) {
		const url = new URL(window.location.href);
		if (newPage > 1) url.searchParams.set('page', String(newPage));
		else url.searchParams.delete('page');
		goto(url.pathname + url.search, { replaceState: true });
	}

	let exporting = $state(false);

	async function handleExport() {
		exporting = true;
		try {
			const ids = (data.invoices as Invoice[]).map((inv) => inv.id);
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

	async function doStatusChange(inv: Invoice, newStatus: InvoiceStatus) {
		togglingId = inv.id;
		try {
			const res = await fetch(`/api/invoices/${inv.id}/status`, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ status: newStatus })
			});
			if (res.ok) {
				toast(t('toast.statusChanged'));
				await invalidateAll();
			} else {
				const data = await res.json().catch(() => ({}));
				toast(data.message || t('toast.failedUpdateStatus'), 'error');
			}
		} catch { toast(t('toast.failedUpdateStatus'), 'error'); }
		togglingId = null;
	}

	function handleStatusSelect(inv: Invoice, newStatus: InvoiceStatus, e: Event) {
		e.stopPropagation();
		openStatusMenuId = null;
		if (newStatus === 'paid' || newStatus === 'cancelled' || (inv.status === 'paid' && newStatus === 'sent')) {
			statusConfirmInvoice = inv;
			statusConfirmTarget = newStatus;
			showStatusConfirm = true;
		} else {
			doStatusChange(inv, newStatus);
		}
	}

	function toggleStatusMenu(inv: Invoice, e: Event) {
		e.stopPropagation();
		if (openStatusMenuId === inv.id) {
			openStatusMenuId = null;
		} else {
			openStatusMenuId = inv.id;
			const btn = e.currentTarget as HTMLElement;
			const rect = btn.getBoundingClientRect();
			statusMenuPos = { top: rect.bottom + 4, left: Math.max(8, rect.right - 160) };
			tick().then(() => {
				const first = statusMenuEl?.querySelector<HTMLElement>('[role="menuitem"]');
				first?.focus();
			});
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

	let clientOptions = $derived([
		{ value: '', label: t('invoice.allClients') },
		...(data.clientNames as string[]).map((n: string) => ({ value: n, label: n }))
	]);

	let columns = $derived([
		{ key: 'documentId', label: t('invoice.numberShort'), sortable: true },
		{ key: 'buyer', label: t('invoice.client'), sortable: true },
		{ key: 'issueDate', label: t('invoice.date'), sortable: true },
		{ key: 'dueDate', label: t('invoice.dueDateShort'), sortable: true },
		{ key: 'total', label: t('invoice.amount'), sortable: true, class: 'text-right' },
		{ key: 'status', label: t('invoice.status') },
	]);

	const badgeClasses: Record<InvoiceStatus, string> = {
		draft: 'bg-near-black/10 text-near-black/80 dark:bg-white/10 dark:text-white/80',
		sent: 'bg-cyan-light text-cyan-dark dark:bg-cyan-900/30 dark:text-cyan-300',
		paid: 'bg-green-100 text-green-800 dark:bg-green-900/30 dark:text-green-300',
		overdue: 'bg-red/10 text-red-dark dark:bg-red-900/30 dark:text-red-300',
		cancelled: 'bg-amber-100 text-amber-800 dark:bg-amber-900/30 dark:text-amber-300',
	};

	let hasFilters = $derived(
		data.filters.status !== '' || data.filters.client !== '' ||
		data.filters.dateFrom !== '' || data.filters.dateTo !== '' || data.filters.search !== ''
	);
</script>

<svelte:head><title>{t('invoice.titlePlural')} | ITCake</title></svelte:head>

<TopBar title={t('invoice.titlePlural')}>
	{#snippet children()}
		<div class="flex gap-2">
			{#if data.totalCount > 0}
				<Button variant="secondary" size="sm" loading={exporting} onclick={handleExport}>{hasFilters ? t('export.pdfCount', { count: data.total }) : t('export.pdf')}</Button>
			{/if}
			<Button size="sm" onclick={() => goto('/invoices/new')}>+ {t('invoice.new')}</Button>
		</div>
	{/snippet}
</TopBar>

<div class="p-6">
	{#if data.totalCount === 0}
		<Card>
			<EmptyState title={t('dashboard.noInvoices')} description={t('empty.createFirstInvoice')}>
				{#snippet children()}
					<Button size="sm" onclick={() => goto('/invoices/new')}>+ {t('invoice.new')}</Button>
				{/snippet}
			</EmptyState>
		</Card>
	{:else}
		<Card flush>
			<!-- Filter bar -->
			<div class="flex flex-wrap items-center gap-2 p-3 border-b border-border sm:p-4">
				<SearchInput value={data.filters.search} oninput={(e: Event) => debouncedSearch((e.currentTarget as HTMLInputElement).value)} placeholder={t('search.placeholder')} class="w-full sm:w-auto sm:max-w-[180px]" />
				<select value={data.filters.status} onchange={(e: Event) => updateFilters({ status: (e.currentTarget as HTMLSelectElement).value })} aria-label={t('label.filterByStatus')}
					class="rounded-lg border border-border bg-input-bg text-near-black px-2.5 py-2 text-xs focus:border-cyan focus:outline-none focus:ring-1 focus:ring-cyan">
					{#each statusDefs as s}
						<option value={s.value}>{t(s.tKey)}</option>
					{/each}
				</select>
				<select value={data.filters.client} onchange={(e: Event) => updateFilters({ client: (e.currentTarget as HTMLSelectElement).value })} aria-label={t('label.filterByClient')}
					class="rounded-lg border border-border bg-input-bg text-near-black px-2.5 py-2 text-xs focus:border-cyan focus:outline-none focus:ring-1 focus:ring-cyan">
					{#each clientOptions as opt}
						<option value={opt.value}>{opt.label}</option>
					{/each}
				</select>
				<!-- Date range: compact icon-trigger inputs -->
				<div class="flex items-center gap-1 ml-auto">
					{#if data.filters.dateFrom || data.filters.dateTo}
						<span class="text-xs text-near-black/60 tabular-nums whitespace-nowrap">
							{data.filters.dateFrom || '...'} – {data.filters.dateTo || '...'}
						</span>
					{/if}
					<label class="relative cursor-pointer rounded-lg border border-border bg-input-bg p-2 hover:bg-bg transition-colors" title={t('label.fromDate')}>
						<svg class="h-3.5 w-3.5 text-near-black/50" fill="none" stroke="currentColor" viewBox="0 0 24 24" stroke-width="1.5"><path stroke-linecap="round" stroke-linejoin="round" d="M6.75 3v2.25M17.25 3v2.25M3 18.75V7.5a2.25 2.25 0 012.25-2.25h13.5A2.25 2.25 0 0121 7.5v11.25m-18 0A2.25 2.25 0 005.25 21h13.5A2.25 2.25 0 0021 18.75m-18 0v-7.5A2.25 2.25 0 015.25 9h13.5A2.25 2.25 0 0121 11.25v7.5" /></svg>
						<input type="date" value={data.filters.dateFrom} onchange={(e: Event) => updateFilters({ from: (e.currentTarget as HTMLInputElement).value })} aria-label={t('label.fromDate')} class="absolute inset-0 opacity-0 cursor-pointer" />
					</label>
					<label class="relative cursor-pointer rounded-lg border border-border bg-input-bg p-2 hover:bg-bg transition-colors" title={t('label.toDate')}>
						<svg class="h-3.5 w-3.5 text-near-black/50" fill="none" stroke="currentColor" viewBox="0 0 24 24" stroke-width="1.5"><path stroke-linecap="round" stroke-linejoin="round" d="M6.75 3v2.25M17.25 3v2.25M3 18.75V7.5a2.25 2.25 0 012.25-2.25h13.5A2.25 2.25 0 0121 7.5v11.25m-18 0A2.25 2.25 0 005.25 21h13.5A2.25 2.25 0 0021 18.75m-18 0v-7.5A2.25 2.25 0 015.25 9h13.5A2.25 2.25 0 0121 11.25v7.5" /></svg>
						<input type="date" value={data.filters.dateTo} onchange={(e: Event) => updateFilters({ to: (e.currentTarget as HTMLInputElement).value })} aria-label={t('label.toDate')} class="absolute inset-0 opacity-0 cursor-pointer" />
					</label>
					{#if hasFilters}
						<button class="text-xs text-red hover:text-red-dark whitespace-nowrap ml-1" onclick={() => updateFilters({ q: '', status: '', client: '', from: '', to: '' })}>{t('action.clearFilters')}</button>
					{/if}
				</div>
			</div>

			<DataTable
				{columns}
				data={data.invoices}
				total={data.total}
				currentPage={data.page}
				pageSize={data.pageSize}
				onpagechange={handlePageChange}
				onrowclick={(inv) => goto(`/invoices/${inv.id}`)}
			>
				{#snippet row(inv: Invoice)}
					<td class="px-4 py-3 font-medium text-near-black">
					{inv.documentId}
					{#if inv.invoiceType === 'creditNote'}
						<span class="ml-1 inline-flex items-center rounded-full bg-amber-100 dark:bg-amber-900/30 px-1.5 py-0.5 text-xs font-medium text-amber-800 dark:text-amber-300" title={t('badge.creditNote')}>{t('badge.creditNoteBadge')}</span>
					{/if}
					{#if inv.recurring?.enabled}
						<span class="ml-1 inline-flex items-center rounded-full bg-cyan/10 px-1.5 py-0.5 text-xs font-medium text-cyan" title={t('invoice.recurringTooltip', { frequency: inv.recurring.frequency })}>
							<svg class="mr-0.5 h-3 w-3" fill="none" stroke="currentColor" viewBox="0 0 24 24" stroke-width="2"><path stroke-linecap="round" stroke-linejoin="round" d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" /></svg>
						</span>
					{/if}
				</td>
					<td class="px-4 py-3 text-near-black/70">{inv.buyer?.name ?? ''}</td>
					<td class="px-4 py-3 text-near-black/70">{formatDate(inv.issueDate, dateFormat)}</td>
					<td class="px-4 py-3 text-near-black/70">{inv.dueDate ? formatDate(inv.dueDate, dateFormat) : ''}</td>
					<td class="px-4 py-3 text-right font-medium tabular-nums">{formatMoney(inv.totals.total, inv.currency)}</td>
					<td class="px-4 py-3">
						<div class="relative">
							{#if (data.statusTransitions[inv.status] ?? []).length > 0}
								<button
									class="inline-flex items-center gap-1 capitalize rounded-full px-2.5 py-0.5 text-xs font-medium cursor-pointer hover:ring-1 hover:ring-current/30 transition-shadow {badgeClasses[inv.status]}"
									onclick={(e) => toggleStatusMenu(inv, e)}
									aria-haspopup="true"
									aria-expanded={openStatusMenuId === inv.id}
								>
									{#if togglingId === inv.id}
										<span class="inline-block h-3 w-3 animate-spin rounded-full border border-current border-t-transparent"></span>
									{:else}
										{t(`status.${inv.status}`)}
										<svg class="h-3 w-3" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 9l-7 7-7-7" /></svg>
									{/if}
								</button>
							{:else}
								<Badge variant={invoiceBadgeVariant(inv.status)}>{t(`status.${inv.status}`)}</Badge>
							{/if}
							{#if openStatusMenuId === inv.id}
								<!-- svelte-ignore a11y_no_static_element_interactions -->
								<div class="fixed inset-0 z-40" role="presentation" aria-hidden="true" onclick={(e) => { e.stopPropagation(); openStatusMenuId = null; }}></div>
								<!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
								<div
									bind:this={statusMenuEl}
									class="fixed z-50 w-40 rounded-lg border border-border bg-bg-card shadow-lg py-1"
									style="top: {statusMenuPos.top}px; left: {statusMenuPos.left}px;"
									role="menu"
									tabindex="-1"
									onkeydown={(e) => {
										if (e.key === 'Escape') { openStatusMenuId = null; return; }
										if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
											e.preventDefault();
											const items = (e.currentTarget as HTMLElement).querySelectorAll<HTMLElement>('[role="menuitem"]');
											const idx = Array.from(items).indexOf(document.activeElement as HTMLElement);
											const next = e.key === 'ArrowDown' ? (idx + 1) % items.length : (idx - 1 + items.length) % items.length;
											items[next]?.focus();
										}
									}}
								>
									{#each data.statusTransitions[inv.status] ?? [] as status}
										<button
											role="menuitem"
											tabindex="-1"
											class="flex items-center gap-2 w-full px-3 py-1.5 text-sm text-near-black/80 hover:bg-bg/50 focus:bg-bg/50 text-left outline-none"
											onclick={(e) => handleStatusSelect(inv, status, e)}
										>
											<span class="inline-flex items-center capitalize rounded-full px-2 py-0.5 text-xs font-medium {badgeClasses[status]}">{t(`status.${status}`)}</span>
										</button>
									{/each}
								</div>
							{/if}
						</div>
					</td>
				{/snippet}
			</DataTable>
		</Card>
	{/if}
</div>

<ConfirmDialog
	open={showStatusConfirm}
	title={t('dialog.changeStatus')}
	message={statusConfirmTarget === 'paid'
		? t('dialog.changeStatusMarkPaid', { id: statusConfirmInvoice?.documentId ?? '' })
		: statusConfirmTarget === 'cancelled'
		? t('dialog.changeStatusGeneric', { status: t('status.cancelled') })
		: t('dialog.confirmUnpaidMessage')}
	confirmLabel={statusConfirmTarget === 'paid'
		? t('dialog.confirmLabelMarkPaid')
		: statusConfirmTarget === 'cancelled'
		? t('dialog.confirmLabelCancelInvoice')
		: t('action.markAsUnpaid')}
	variant={statusConfirmTarget === 'cancelled' ? 'danger' : 'primary'}
	onconfirm={() => {
		showStatusConfirm = false;
		if (statusConfirmInvoice && statusConfirmTarget) doStatusChange(statusConfirmInvoice, statusConfirmTarget);
		statusConfirmInvoice = null;
		statusConfirmTarget = null;
	}}
	oncancel={() => { showStatusConfirm = false; statusConfirmInvoice = null; statusConfirmTarget = null; }}
/>
