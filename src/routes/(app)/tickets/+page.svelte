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
	import { invalidateAll } from '$app/navigation';
	import { page } from '$app/state';
	import { onMount } from 'svelte';
	import dayjs from 'dayjs';
	import type { PageData } from './$types.js';
	import type { Ticket, TicketStatus } from '$lib/types.js';
	import type { TicketFormData } from '$components/tickets/TicketForm.svelte';

	let { data }: { data: PageData } = $props();

	// Auto-open form when navigating via QuickCreate (?new=1)
	onMount(() => {
		if (page.url.searchParams.get('new') === '1') {
			editingTicket = null;
			showForm = true;
			// Clean URL without reloading
			history.replaceState({}, '', '/tickets');
		}
	});

	let search = $state('');
	let statusFilter = $state<TicketStatus | 'all'>('all');
	let clientFilter = $state('');
	let viewMode = $state<'list' | 'calendar'>('list');
	let calendarMode = $state<'day' | '3day' | 'week'>('week');

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

	// Filtered tickets
	let filteredTickets = $derived.by(() => {
		let result = data.tickets;
		if (statusFilter !== 'all') {
			result = result.filter(t => t.status === statusFilter);
		}
		if (clientFilter) {
			result = result.filter(t => t.clientId === clientFilter);
		}
		if (search) {
			const q = search.toLowerCase();
			result = result.filter(t =>
				t.ticketNumber.toLowerCase().includes(q) ||
				(t.title ?? '').toLowerCase().includes(q) ||
				(t.notes ?? '').toLowerCase().includes(q)
			);
		}
		// Sort by date DESC
		return result.sort((a, b) => b.date.localeCompare(a.date) || b.startTime.localeCompare(a.startTime));
	});

	// Summary stats
	let now = dayjs();
	let weekStart = $derived(now.startOf('week').add(now.day() === 0 ? -6 : 1, 'day'));
	let monthStart = $derived(now.startOf('month'));

	let stats = $derived.by(() => {
		const ws = weekStart.format('YYYY-MM-DD');
		const ms = monthStart.format('YYYY-MM-DD');
		const today = now.format('YYYY-MM-DD');

		let hoursWeek = 0, hoursMonth = 0, earningsWeek = 0, earningsMonth = 0;
		for (const t of data.tickets) {
			const total = Math.round(t.hours * t.hourlyRate);
			if (t.date >= ws && t.date <= today) {
				hoursWeek += t.hours;
				earningsWeek += total;
			}
			if (t.date >= ms && t.date <= today) {
				hoursMonth += t.hours;
				earningsMonth += total;
			}
		}
		return { hoursWeek, hoursMonth, earningsWeek, earningsMonth };
	});

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
				<SearchInput bind:value={search} placeholder={t('search.placeholder')} />
			</div>
			<div class="w-40">
				<Select bind:value={statusFilter} options={statusSelectOptions} />
			</div>
			<div class="w-48">
				<Select bind:value={clientFilter} options={clientSelectOptions} />
			</div>
		</div>

		<!-- View toggle -->
		<div class="flex items-center gap-2">
			<div class="flex rounded-lg border border-border overflow-hidden">
				<button
					class="px-3 py-1.5 text-sm font-medium transition-colors {viewMode === 'list' ? 'bg-cyan text-white' : 'text-near-black/60 hover:bg-near-black/5'}"
					onclick={() => viewMode = 'list'}
				>{t('ticket.listView')}</button>
				<button
					class="px-3 py-1.5 text-sm font-medium transition-colors {viewMode === 'calendar' ? 'bg-cyan text-white' : 'text-near-black/60 hover:bg-near-black/5'}"
					onclick={() => viewMode = 'calendar'}
				>{t('ticket.calendarView')}</button>
			</div>

			{#if viewMode === 'calendar'}
				<div class="flex rounded-lg border border-border overflow-hidden ml-2">
					<button
						class="px-2 py-1.5 text-xs font-medium transition-colors {calendarMode === 'day' ? 'bg-near-black/10 text-near-black' : 'text-near-black/60 hover:bg-near-black/5'}"
						onclick={() => calendarMode = 'day'}
					>{t('ticket.dayView')}</button>
					<button
						class="px-2 py-1.5 text-xs font-medium transition-colors {calendarMode === '3day' ? 'bg-near-black/10 text-near-black' : 'text-near-black/60 hover:bg-near-black/5'}"
						onclick={() => calendarMode = '3day'}
					>{t('ticket.threeDayView')}</button>
					<button
						class="px-2 py-1.5 text-xs font-medium transition-colors {calendarMode === 'week' ? 'bg-near-black/10 text-near-black' : 'text-near-black/60 hover:bg-near-black/5'}"
						onclick={() => calendarMode = 'week'}
					>{t('ticket.weekView')}</button>
				</div>
			{/if}
		</div>

		<!-- Content -->
		{#if viewMode === 'list'}
			{#if filteredTickets.length > 0}
				<div class="space-y-2">
					{#each filteredTickets as ticket (ticket.id)}
						<TicketCard
							{ticket}
							clients={data.clients}
							onEdit={openEdit}
							onDelete={(t) => deleteTarget = t}
							onStatusChange={handleStatusChange}
							onToInvoice={(t) => invoiceTarget = t}
						/>
					{/each}
				</div>
			{:else}
				<EmptyState title={t('search.noResults')} description="" />
			{/if}
		{:else}
			<TicketCalendar
				tickets={filteredTickets}
				clients={data.clients}
				mode={calendarMode}
				{currency}
				{lang}
				onTicketClick={handleCalendarTicketClick}
			/>
		{/if}
	{:else}
		<EmptyState title={t('ticket.noTickets')} description={t('ticket.noTicketsDescription')}>
			{#snippet children()}
				<Button onclick={openNew} class="mt-4">+ {t('ticket.new')}</Button>
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
