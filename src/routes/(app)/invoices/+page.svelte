<script lang="ts">
	import { goto, invalidateAll } from '$app/navigation';
	import TopBar from '#lib/components/shell/TopBar.svelte';
	import Btn from '#lib/components/ui/Btn.svelte';
	import Card from '#lib/components/ui/Card.svelte';
	import Tag from '#lib/components/ui/Tag.svelte';
	import StatusPill from '#lib/components/ui/StatusPill.svelte';
	import EmptyStateV2 from '#lib/components/ui/EmptyState.svelte';
	import DataTable from '#components/ui/DataTable.svelte';
	import SearchInput from '#components/ui/SearchInput.svelte';
	import ConfirmDialog from '#components/ui/ConfirmDialog.svelte';
	import { tick } from 'svelte';
	import { invoiceStatusTone } from '#lib/select-options.js';
	import { toast } from '#components/ui/Toast.svelte';
	import { formatMoney } from '#lib/money.js';
	import { formatDate } from '#lib/format-date.js';
	import { t } from '#lib/i18n/index.svelte.js';
	import type { Invoice, InvoiceStatus } from '#lib/types.js';
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
		url.searchParams.delete('page');
		goto(url.pathname + url.search, { replace: true, reset: false });
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

	function handleSortChange(key: string, dir: 'asc' | 'desc') {
		const url = new URL(window.location.href);
		url.searchParams.set('sort', key);
		url.searchParams.set('dir', dir);
		url.searchParams.delete('page');
		goto(url.pathname + url.search, { replace: true, reset: false });
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

	let hasFilters = $derived(
		data.filters.status !== '' || data.filters.client !== '' ||
		data.filters.dateFrom !== '' || data.filters.dateTo !== '' || data.filters.search !== ''
	);
</script>

<svelte:head><title>{t('invoice.titlePlural')} | ITCake</title></svelte:head>

<TopBar
	title={t('invoice.titlePlural')}
	breadcrumb={['Billing', t('invoice.titlePlural')]}
>
	{#snippet right()}
		{#if data.totalCount > 0}
			<Btn variant="ghost" size="sm" disabled={exporting} onclick={handleExport}>
				{hasFilters ? t('export.pdfCount', { count: data.total }) : t('export.pdf')}
			</Btn>
		{/if}
		<Btn variant="primary" size="sm" onclick={() => goto('/invoices/new')}>+ {t('invoice.new')}</Btn>
	{/snippet}
</TopBar>

<div class="p-5">
	{#if data.totalCount === 0}
		<Card>
			<EmptyStateV2 title={t('dashboard.noInvoices')} description={t('empty.createFirstInvoice')}>
				{#snippet actions()}
					<Btn variant="primary" size="sm" onclick={() => goto('/invoices/new')}>+ {t('invoice.new')}</Btn>
				{/snippet}
			</EmptyStateV2>
		</Card>
	{:else}
		<Card padding={0}>
			<div class="flex flex-wrap items-center gap-2 px-3 py-2 border-b" style="border-color:var(--line-2)">
				<SearchInput
					value={data.filters.search}
					oninput={(e: Event) => debouncedSearch((e.currentTarget as HTMLInputElement).value)}
					placeholder={t('search.placeholder')}
					class="w-full sm:w-auto sm:max-w-[180px]"
				/>
				<select
					value={data.filters.status}
					onchange={(e: Event) => updateFilters({ status: (e.currentTarget as HTMLSelectElement).value })}
					aria-label={t('label.filterByStatus')}
					class="rounded-md border bg-[var(--card)] px-2.5 py-1 text-[12px] focus:outline-none focus:ring-2"
					style="border-color:var(--line);color:var(--ink);--tw-ring-color:var(--brand)"
				>
					{#each statusDefs as s}
						<option value={s.value}>{t(s.tKey)}</option>
					{/each}
				</select>
				<select
					value={data.filters.client}
					onchange={(e: Event) => updateFilters({ client: (e.currentTarget as HTMLSelectElement).value })}
					aria-label={t('label.filterByClient')}
					class="rounded-md border bg-[var(--card)] px-2.5 py-1 text-[12px] focus:outline-none focus:ring-2"
					style="border-color:var(--line);color:var(--ink);--tw-ring-color:var(--brand)"
				>
					{#each clientOptions as opt}
						<option value={opt.value}>{opt.label}</option>
					{/each}
				</select>
				<div class="flex items-center gap-1 ml-auto">
					{#if data.filters.dateFrom || data.filters.dateTo}
						<span class="text-[11px] num whitespace-nowrap" style="color:var(--muted)">
							{data.filters.dateFrom || '...'} – {data.filters.dateTo || '...'}
						</span>
					{/if}
					<label class="relative cursor-pointer rounded-md border p-1.5 transition-colors" style="border-color:var(--line);background:var(--card)" title={t('label.fromDate')}>
						<svg class="h-3.5 w-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24" stroke-width="1.5" style="color:var(--muted)"><path stroke-linecap="round" stroke-linejoin="round" d="M6.75 3v2.25M17.25 3v2.25M3 18.75V7.5a2.25 2.25 0 012.25-2.25h13.5A2.25 2.25 0 0121 7.5v11.25m-18 0A2.25 2.25 0 005.25 21h13.5A2.25 2.25 0 0021 18.75m-18 0v-7.5A2.25 2.25 0 015.25 9h13.5A2.25 2.25 0 0121 11.25v7.5" /></svg>
						<input type="date" value={data.filters.dateFrom} onchange={(e: Event) => updateFilters({ from: (e.currentTarget as HTMLInputElement).value })} aria-label={t('label.fromDate')} class="absolute inset-0 opacity-0 cursor-pointer" />
					</label>
					<label class="relative cursor-pointer rounded-md border p-1.5 transition-colors" style="border-color:var(--line);background:var(--card)" title={t('label.toDate')}>
						<svg class="h-3.5 w-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24" stroke-width="1.5" style="color:var(--muted)"><path stroke-linecap="round" stroke-linejoin="round" d="M6.75 3v2.25M17.25 3v2.25M3 18.75V7.5a2.25 2.25 0 012.25-2.25h13.5A2.25 2.25 0 0121 7.5v11.25m-18 0A2.25 2.25 0 005.25 21h13.5A2.25 2.25 0 0021 18.75m-18 0v-7.5A2.25 2.25 0 015.25 9h13.5A2.25 2.25 0 0121 11.25v7.5" /></svg>
						<input type="date" value={data.filters.dateTo} onchange={(e: Event) => updateFilters({ to: (e.currentTarget as HTMLInputElement).value })} aria-label={t('label.toDate')} class="absolute inset-0 opacity-0 cursor-pointer" />
					</label>
					{#if hasFilters}
						<button class="text-[11px] whitespace-nowrap ml-1" style="color:var(--bad)" onclick={() => updateFilters({ q: '', status: '', client: '', from: '', to: '' })}>{t('action.clearFilters')}</button>
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
				sortKey={data.sort}
				sortDir={data.dir}
				onsortchange={handleSortChange}
				onrowclick={(inv) => goto(`/invoices/${inv.id}`)}
			>
				{#snippet row(inv: Invoice)}
					<td class="px-4 py-2.5 font-mono text-[11.5px] font-medium" style="color:var(--ink)">
						{inv.documentId}
						{#if inv.invoiceType === 'creditNote'}
							<span class="ml-1"><Tag tone="accent" title={t('badge.creditNote')}>{t('badge.creditNoteBadge')}</Tag></span>
						{/if}
						{#if inv.recurring?.enabled}
							<span class="ml-1 inline-flex items-center rounded-full px-1.5 py-0.5 text-[10.5px]" style="background:var(--brand-soft);color:var(--brand-ink)" title={t('invoice.recurringTooltip', { frequency: inv.recurring.frequency })}>
								<svg class="h-3 w-3" fill="none" stroke="currentColor" viewBox="0 0 24 24" stroke-width="2" aria-hidden="true"><path stroke-linecap="round" stroke-linejoin="round" d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" /></svg>
							</span>
						{/if}
					</td>
					<td class="px-4 py-2.5 text-[12.5px] font-medium" style="color:var(--ink)">{inv.buyer?.name ?? ''}</td>
					<td class="px-4 py-2.5 text-[12.5px] num" style="color:var(--muted)">{formatDate(inv.issueDate, dateFormat)}</td>
					<td class="px-4 py-2.5 text-[12.5px] num" style="color:var(--muted)">{inv.dueDate ? formatDate(inv.dueDate, dateFormat) : '—'}</td>
					<td class="px-4 py-2.5 text-right text-[12.5px] font-medium num" style="color:var(--ink)">{formatMoney(inv.totals.total, inv.currency)}</td>
					<td class="px-4 py-2.5">
						<div class="relative">
							{#if (data.statusTransitions[inv.status] ?? []).length > 0}
								<StatusPill
									tone={invoiceStatusTone(inv.status)}
									ariaLabel={t('aria.changeStatus', { status: t('status.' + inv.status) })}
									onclick={(e) => toggleStatusMenu(inv, e)}
								>
									{#if togglingId === inv.id}
										<span class="inline-block h-3 w-3 animate-spin rounded-full border border-current border-t-transparent"></span>
									{:else}
										{t(`status.${inv.status}`)}
									{/if}
								</StatusPill>
							{:else}
								<Tag tone={invoiceStatusTone(inv.status)}>{t(`status.${inv.status}`)}</Tag>
							{/if}
							{#if openStatusMenuId === inv.id}
								<!-- svelte-ignore a11y_no_static_element_interactions -->
								<div class="fixed inset-0 z-40" role="presentation" aria-hidden="true" onclick={(e) => { e.stopPropagation(); openStatusMenuId = null; }}></div>
								<!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
								<div
									bind:this={statusMenuEl}
									class="fixed z-50 w-40 rounded-md border bg-[var(--card)] shadow-pop py-1"
									style="top: {statusMenuPos.top}px; left: {statusMenuPos.left}px; border-color:var(--line)"
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
											class="flex items-center gap-2 w-full px-3 py-1.5 text-[12px] text-left outline-none transition-colors hover:bg-[var(--brand-soft)]"
											style="color:var(--ink)"
											onclick={(e) => handleStatusSelect(inv, status, e)}
										>
											<Tag tone={invoiceStatusTone(status)}>{t(`status.${status}`)}</Tag>
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
