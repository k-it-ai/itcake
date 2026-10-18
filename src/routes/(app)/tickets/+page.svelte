<script lang="ts">
	import TopBar from '#lib/components/shell/TopBar.svelte';
	import Btn from '#lib/components/ui/Btn.svelte';
	import Card from '#lib/components/ui/Card.svelte';
	import EmptyStateV2 from '#lib/components/ui/EmptyState.svelte';
	import SearchInput from '#components/ui/SearchInput.svelte';
	import Select from '#components/ui/Select.svelte';
	import ConfirmDialog from '#components/ui/ConfirmDialog.svelte';
	import TicketCard from '#components/tickets/TicketCard.svelte';
	import TicketForm from '#components/tickets/TicketForm.svelte';
	import ToInvoiceModal from '#components/tickets/ToInvoiceModal.svelte';
	import TicketCalendar from '#components/tickets/TicketCalendar.svelte';
	import { toast } from '#components/ui/Toast.svelte';
	import { t } from '#lib/i18n/index.svelte.js';
	import { formatMoney } from '#lib/money.js';
	import { goto, invalidateAll } from '$app/navigation';
	import { page } from '$app/state';
	import type { PageData } from './$types.js';
	import type { Ticket, TicketStatus } from '#lib/types.js';
	import type { TicketFormData } from '#components/tickets/TicketForm.svelte';

	let { data }: { data: PageData } = $props();

	$effect(() => {
		if (page.url.searchParams.get('new') === '1') {
			editingTicket = null;
			showForm = true;
			history.replaceState({}, '', '/tickets');
		}
	});

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

	let stats = $derived(data.stats);

	function applyFilters() {
		const url = new URL(page.url.href);
		url.searchParams.delete('page');
		if (statusFilter && statusFilter !== 'all') url.searchParams.set('status', statusFilter); else url.searchParams.delete('status');
		if (clientFilter) url.searchParams.set('clientId', clientFilter); else url.searchParams.delete('clientId');
		if (search) url.searchParams.set('q', search); else url.searchParams.delete('q');
		goto(url.toString(), { replaceState: true });
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
		editingTicket = ticket;
		showForm = true;
	}
</script>

<svelte:head><title>{t('ticket.titlePlural')} | ITCake</title></svelte:head>

<TopBar
	title={t('ticket.titlePlural')}
	breadcrumb={['Service desk', t('ticket.titlePlural')]}
>
	{#snippet right()}
		<Btn variant="primary" size="sm" onclick={openNew}>+ {t('ticket.new')}</Btn>
	{/snippet}
</TopBar>

<div class="p-5 space-y-5">
	{#if data.tickets.length > 0 || stats.hoursWeek > 0 || stats.hoursMonth > 0}
		<div class="grid grid-cols-2 sm:grid-cols-4 gap-3">
			<Card>
				<p class="text-[11.5px]" style="color:var(--muted)">{t('ticket.hoursThisWeek')}</p>
				<p class="mt-1 text-[20px] font-semibold tracking-tight num" style="color:var(--ink)">{stats.hoursWeek.toFixed(1)}</p>
			</Card>
			<Card>
				<p class="text-[11.5px]" style="color:var(--muted)">{t('ticket.hoursThisMonth')}</p>
				<p class="mt-1 text-[20px] font-semibold tracking-tight num" style="color:var(--ink)">{stats.hoursMonth.toFixed(1)}</p>
			</Card>
			<Card>
				<p class="text-[11.5px]" style="color:var(--muted)">{t('ticket.earningsThisWeek')}</p>
				<p class="mt-1 text-[20px] font-semibold tracking-tight num" style="color:var(--ink)">{formatMoney(stats.earningsWeek, currency)}</p>
			</Card>
			<Card>
				<p class="text-[11.5px]" style="color:var(--muted)">{t('ticket.earningsThisMonth')}</p>
				<p class="mt-1 text-[20px] font-semibold tracking-tight num" style="color:var(--ink)">{formatMoney(stats.earningsMonth, currency)}</p>
			</Card>
		</div>
	{/if}

	{#if data.tickets.length > 0}
		<Card padding={0}>
			<div class="flex flex-wrap items-center gap-2 px-3 py-2 border-b" style="border-color:var(--line-2)">
				<div class="flex-1 min-w-[200px]">
					<SearchInput bind:value={search} placeholder={t('search.placeholder')} oninput={() => { clearTimeout(searchTimer); searchTimer = setTimeout(applyFilters, 400); }} />
				</div>
				<div class="w-40">
					<Select bind:value={statusFilter} options={statusSelectOptions} onchange={() => applyFilters()} />
				</div>
				<div class="w-48">
					<Select bind:value={clientFilter} options={clientSelectOptions} onchange={() => applyFilters()} />
				</div>
				<div class="ml-auto flex rounded-md border overflow-hidden" style="border-color:var(--line)">
					<button
						class="px-2.5 py-1 text-[12px] font-medium transition-colors"
						style="background:{viewMode === 'list' ? 'var(--brand-soft)' : 'var(--card)'}; color:{viewMode === 'list' ? 'var(--brand-ink)' : 'var(--muted)'}"
						onclick={() => viewMode = 'list'}
					>{t('ticket.listView')}</button>
					<button
						class="px-2.5 py-1 text-[12px] font-medium transition-colors border-l"
						style="background:{viewMode === 'calendar' ? 'var(--brand-soft)' : 'var(--card)'}; color:{viewMode === 'calendar' ? 'var(--brand-ink)' : 'var(--muted)'}; border-color:var(--line)"
						onclick={() => viewMode = 'calendar'}
					>{t('ticket.calendarView')}</button>
				</div>
			</div>

			{#if viewMode === 'list'}
				<div class="p-3 space-y-2">
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
				<div class="p-3">
					<div class="flex items-center gap-2 mb-3">
						<div class="flex rounded-md border overflow-hidden" style="border-color:var(--line)">
							<button
								class="px-2.5 py-1 text-[12px] font-medium transition-colors"
								style="background:{calendarMode === 'day' ? 'var(--brand-soft)' : 'var(--card)'}; color:{calendarMode === 'day' ? 'var(--brand-ink)' : 'var(--muted)'}"
								onclick={() => calendarMode = 'day'}
							>{t('ticket.dayView')}</button>
							<button
								class="px-2.5 py-1 text-[12px] font-medium transition-colors border-l"
								style="background:{calendarMode === '3day' ? 'var(--brand-soft)' : 'var(--card)'}; color:{calendarMode === '3day' ? 'var(--brand-ink)' : 'var(--muted)'}; border-color:var(--line)"
								onclick={() => calendarMode = '3day'}
							>{t('ticket.threeDayView')}</button>
							<button
								class="px-2.5 py-1 text-[12px] font-medium transition-colors border-l"
								style="background:{calendarMode === 'week' ? 'var(--brand-soft)' : 'var(--card)'}; color:{calendarMode === 'week' ? 'var(--brand-ink)' : 'var(--muted)'}; border-color:var(--line)"
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
				</div>
			{/if}
		</Card>
	{:else}
		<Card>
			<EmptyStateV2 title={t('ticket.noTickets')} description={t('ticket.noTicketsDescription')}>
				{#snippet actions()}
					<Btn variant="primary" size="sm" onclick={openNew}>+ {t('ticket.new')}</Btn>
				{/snippet}
			</EmptyStateV2>
		</Card>
	{/if}
</div>

<TicketForm
	bind:open={showForm}
	ticket={editingTicket}
	clients={data.clients}
	{currency}
	onclose={() => showForm = false}
	onsave={handleSave}
/>

<ToInvoiceModal
	open={!!invoiceTarget}
	ticket={invoiceTarget}
	draftInvoices={data.targetInvoices}
	{currency}
	onclose={() => invoiceTarget = null}
	onconfirm={handleToInvoice}
/>

<ConfirmDialog
	open={!!deleteTarget}
	title={t('dialog.deleteTicket')}
	message={t('dialog.deleteTicketMessage', { title: deleteTarget?.ticketNumber ?? '' })}
	confirmLabel={t('action.delete')}
	variant="danger"
	onconfirm={handleDelete}
	oncancel={() => deleteTarget = null}
/>
