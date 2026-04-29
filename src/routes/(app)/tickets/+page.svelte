<script lang="ts">
	import TopBar from '$components/layout/TopBar.svelte';
	import Button from '$components/ui/Button.svelte';
	import Card from '$components/ui/Card.svelte';
	import SearchInput from '$components/ui/SearchInput.svelte';
	import Select from '$components/ui/Select.svelte';
	import EmptyState from '$components/ui/EmptyState.svelte';
	import ConfirmDialog from '$components/ui/ConfirmDialog.svelte';
	import TicketCard from '$components/tickets/TicketCard.svelte';
	import TicketForm from '$components/tickets/TicketForm.svelte';
	import ToInvoiceModal from '$components/tickets/ToInvoiceModal.svelte';
	import TicketCalendar from '$components/tickets/TicketCalendar.svelte';
	import { toast } from '$components/ui/Toast.svelte';
	import { t } from '$lib/i18n/index.svelte.js';
	import { formatMoney } from '$lib/money.js';
	import { goto, invalidateAll } from '$app/navigation';
	import { page } from '$app/state';
	import type { PageData } from './$types.js';
	import type { Ticket, TicketStatus } from '$lib/types.js';
	import type { TicketFormData } from '$components/tickets/TicketForm.svelte';

	let { data }: { data: PageData } = $props();

	// Auto-open form when navigating via QuickCreate (?new=1)
	$effect(() => {
		if (page.url.searchParams.get('new') === '1') {
			editingTicket = null;
			showForm = true;
			history.replaceState({}, '', '/tickets');
		}
	});

	// Server-driven filters (from URL params)
	let search = $state(data.filters.search);
	let statusFilter = $state<string>(data.filters.status || 'all');
	let clientFilter = $state(data.filters.clientId);
	let viewMode = $state<'list' | 'calendar'>('list');
	let calendarMode = $state<'day' | '3day' | 'week'>('week');
	let searchTimer: ReturnType<typeof setTimeout>;

	let showForm = $state(false);
	let editingTicket = $state<Ticket | null>(null);
	let deleteTarget = $state<Ticket | null>(null);
	let invoiceTarget = $state<Ticket | null>(null);

	let currency = $derived(data.settings?.general?.currency || 'EUR');
	let lang = $derived(data.settings?.general?.language || 'en');

	let statusSelectOptions = $derived([
		{ value: 'all', label: t('status.all') },
		{ value: 'open', label: t('status.open') },
		{ value: 'completed', label: t('status.completed') },
		{ value: 'invoiced', label: t('status.invoiced') },
	]);

	let clientSelectOptions = $derived([
		{ value: '', label: t('ticket.allClients') },
		...data.clients.map(c => ({ value: c.id, label: c.name }))
	]);

	// Stats from server (calculated across ALL tickets, not just current page)
	let stats = $derived(data.stats);

	function applyFilters() {
		const url = new URL(page.url);
		url.searchParams.delete('page');
		if (statusFilter && statusFilter !== 'all') url.searchParams.set('status', statusFilter); else url.searchParams.delete('status');
		if (clientFilter) url.searchParams.set('clientId', clientFilter); else url.searchParams.delete('clientId');
		if (search) url.searchParams.set('q', search); else url.searchParams.delete('q');
		goto(url.toString(), { replaceState: true });
	}

	function handlePageChange(newPage: number) {
		const url = new URL(page.url);
		if (newPage > 1) url.searchParams.set('page', String(newPage)); else url.searchParams.delete('page');
		goto(url.toString());
	}

	function openNew() {
		editingTicket = null;
		showForm = true;
	}

	function openEdit(ticket: Ticket) {
		editingTicket = ticket;
		showForm = true;
	}

	async function handleSave(formData: TicketFormData) {
		const isEdit = !!editingTicket;
		const body = isEdit
			? { action: 'update', id: editingTicket!.id, ...formData }
			: formData;

		try {
			const res = await fetch('/api/tickets', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify(body)
			});
			if (res.ok) {
				toast(t(isEdit ? 'toast.ticketUpdated' : 'toast.ticketCreated'));
				showForm = false;
				await invalidateAll();
			} else {
				const err = await res.json().catch(() => ({}));
				toast(err.message || t('toast.error'), 'error');
			}
		} catch {
			toast(t('toast.networkError'), 'error');
		}
	}

	async function handleDelete() {
		if (!deleteTarget) return;
		try {
			const res = await fetch('/api/tickets', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ action: 'delete', id: deleteTarget.id })
			});
			if (res.ok) {
				toast(t('toast.ticketDeleted'));
				deleteTarget = null;
				await invalidateAll();
			} else {
				const err = await res.json().catch(() => ({}));
				toast(err.message || t('toast.error'), 'error');
			}
		} catch {
			toast(t('toast.networkError'), 'error');
		}
	}

	async function handleStatusChange(ticket: Ticket, status: TicketStatus) {
		try {
			const res = await fetch('/api/tickets', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ action: 'status', id: ticket.id, status })
			});
			if (res.ok) {
				toast(t(status === 'completed' ? 'toast.ticketCompleted' : 'toast.ticketReopened'));
				await invalidateAll();
			} else {
				const err = await res.json().catch(() => ({}));
				toast(err.message || t('toast.error'), 'error');
			}
		} catch {
			toast(t('toast.networkError'), 'error');
		}
	}

	async function handleToInvoice(mode: 'new' | 'existing', invoiceId?: string) {
		if (!invoiceTarget) return;
		try {
			const res = await fetch('/api/tickets', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ action: 'toInvoice', id: invoiceTarget.id, mode, invoiceId })
			});
			if (res.ok) {
				toast(t('toast.ticketInvoiced'));
				invoiceTarget = null;
				await invalidateAll();
			} else {
				const err = await res.json().catch(() => ({}));
				toast(err.message || t('toast.error'), 'error');
			}
		} catch {
			toast(t('toast.networkError'), 'error');
		}
	}

	function handleCalendarTicketClick(ticket: Ticket) {
		// Open the edit form for the clicked ticket
		editingTicket = ticket;
		showForm = true;
	}
</script>

<svelte:head><title>{t('ticket.titlePlural')} | ITCake</title></svelte:head>

<TopBar title={t('ticket.titlePlural')}>
	{#snippet children()}
		<Button size="sm" onclick={openNew}>+ {t('ticket.new')}</Button>
	{/snippet}
</TopBar>

<div class="p-6 space-y-6">
	<!-- Summary cards -->
	{#if data.tickets.length > 0}
		<div class="grid grid-cols-2 sm:grid-cols-4 gap-4">
			<Card>
				<div class="text-center">
					<div class="text-2xl font-bold text-near-black">{stats.hoursWeek.toFixed(1)}</div>
					<div class="text-xs text-near-black/60">{t('ticket.hoursThisWeek')}</div>
				</div>
			</Card>
			<Card>
				<div class="text-center">
					<div class="text-2xl font-bold text-near-black">{stats.hoursMonth.toFixed(1)}</div>
					<div class="text-xs text-near-black/60">{t('ticket.hoursThisMonth')}</div>
				</div>
			</Card>
			<Card>
				<div class="text-center">
					<div class="text-2xl font-bold text-near-black">{formatMoney(stats.earningsWeek, currency)}</div>
					<div class="text-xs text-near-black/60">{t('ticket.earningsThisWeek')}</div>
				</div>
			</Card>
			<Card>
				<div class="text-center">
					<div class="text-2xl font-bold text-near-black">{formatMoney(stats.earningsMonth, currency)}</div>
					<div class="text-xs text-near-black/60">{t('ticket.earningsThisMonth')}</div>
				</div>
			</Card>
		</div>

		<!-- Filters row -->
		<div class="flex flex-wrap items-center gap-3">
			<div class="flex-1 min-w-[200px]">
				<SearchInput bind:value={search} placeholder={t('search.placeholder')} oninput={() => { clearTimeout(searchTimer); searchTimer = setTimeout(applyFilters, 400); }} />
			</div>
			<div class="w-40">
				<Select bind:value={statusFilter} options={statusSelectOptions} onchange={() => applyFilters()} />
			</div>
			<div class="w-48">
				<Select bind:value={clientFilter} options={clientSelectOptions} onchange={() => applyFilters()} />
			</div>
		</div>

		<!-- Ticket list -->
		{#if data.tickets.length > 0}
			<div class="space-y-2">
				{#each data.tickets as ticket (ticket.id)}
					<TicketCard
						{ticket}
						clients={data.clients}
						onEdit={openEdit}
						onDelete={(tk) => deleteTarget = tk}
						onStatusChange={handleStatusChange}
						onToInvoice={(tk) => invoiceTarget = tk}
					/>
				{/each}
			</div>
		{:else}
			<EmptyState title={t('search.noResults')} description="" />
		{/if}

		<!-- Calendar toggle + calendar -->
		<div>
			<button
				class="flex items-center gap-2 text-sm text-near-black/60 hover:text-near-black transition-colors mb-3"
				onclick={() => viewMode = viewMode === 'list' ? 'calendar' : 'list'}
			>
				<svg class="h-4 w-4 transition-transform {viewMode === 'calendar' ? 'rotate-180' : ''}" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 9l-7 7-7-7" /></svg>
				{t('ticket.calendarView')}
			</button>

			{#if viewMode === 'calendar'}
				<div class="flex items-center gap-2 mb-3">
					<div class="flex rounded-lg border border-border overflow-hidden">
						<button
							class="px-2 py-1 text-xs font-medium transition-colors {calendarMode === 'day' ? 'bg-near-black/10 text-near-black' : 'text-near-black/60 hover:bg-near-black/5'}"
							onclick={() => calendarMode = 'day'}
						>{t('ticket.dayView')}</button>
						<button
							class="px-2 py-1 text-xs font-medium transition-colors {calendarMode === '3day' ? 'bg-near-black/10 text-near-black' : 'text-near-black/60 hover:bg-near-black/5'}"
							onclick={() => calendarMode = '3day'}
						>{t('ticket.threeDayView')}</button>
						<button
							class="px-2 py-1 text-xs font-medium transition-colors {calendarMode === 'week' ? 'bg-near-black/10 text-near-black' : 'text-near-black/60 hover:bg-near-black/5'}"
							onclick={() => calendarMode = 'week'}
						>{t('ticket.weekView')}</button>
					</div>
				</div>
				<TicketCalendar
					tickets={data.calendarTickets.length > 0 ? data.calendarTickets : data.tickets}
					clients={data.clients}
					mode={calendarMode}
					{currency}
					{lang}
					onTicketClick={handleCalendarTicketClick}
				/>
			{/if}
		</div>
	{:else}
		<EmptyState title={t('ticket.noTickets')} description={t('ticket.noTicketsDescription')}>
			{#snippet children()}
				<Button size="sm" onclick={openNew} class="mt-4">+ {t('ticket.new')}</Button>
			{/snippet}
		</EmptyState>
	{/if}
</div>

<!-- Ticket form modal -->
<TicketForm
	bind:open={showForm}
	ticket={editingTicket}
	clients={data.clients}
	{currency}
	onclose={() => showForm = false}
	onsave={handleSave}
/>

<!-- To Invoice modal -->
<ToInvoiceModal
	open={!!invoiceTarget}
	ticket={invoiceTarget}
	draftInvoices={data.targetInvoices}
	{currency}
	onclose={() => invoiceTarget = null}
	onconfirm={handleToInvoice}
/>

<!-- Delete confirmation -->
<ConfirmDialog
	open={!!deleteTarget}
	title={t('dialog.deleteTicket')}
	message={t('dialog.deleteTicketMessage', { title: deleteTarget?.ticketNumber ?? '' })}
	confirmLabel={t('action.delete')}
	variant="danger"
	onconfirm={handleDelete}
	oncancel={() => deleteTarget = null}
/>
