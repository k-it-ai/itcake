<script lang="ts">
	import { page } from '$app/state';
	import { t } from '$lib/i18n/index.svelte.js';
	import { formatDate } from '$lib/format-date.js';
	import { formatMoney } from '$lib/money.js';
	import Button from '$components/ui/Button.svelte';
	import type { Ticket, Client, TicketStatus } from '$lib/types.js';

	let dateFormat = $derived(page.data?.settings?.general?.dateFormat || 'DD/MM/YYYY');
	let currency = $derived(page.data?.settings?.general?.currency || 'EUR');
	let lang = $derived(page.data?.settings?.general?.language || 'en');

	function formatTime(time: string): string {
		if (lang === 'en') {
			const [h, m] = time.split(':').map(Number);
			const suffix = h >= 12 ? 'PM' : 'AM';
			const h12 = h % 12 || 12;
			return `${h12}:${String(m).padStart(2, '0')} ${suffix}`;
		}
		return time;
	}

	interface Props {
		ticket: Ticket;
		clients: Client[];
		onEdit: (ticket: Ticket) => void;
		onDelete: (ticket: Ticket) => void;
		onStatusChange: (ticket: Ticket, status: TicketStatus) => void;
		onToInvoice: (ticket: Ticket) => void;
	}

	let { ticket, clients, onEdit, onDelete, onStatusChange, onToInvoice }: Props = $props();

	let expanded = $state(false);
	let statusMenuOpen = $state(false);

	let clientName = $derived(clients.find(c => c.id === ticket.clientId)?.name ?? '—');
	let totalAmount = $derived(Math.round(ticket.hours * ticket.hourlyRate));

	// Compute end time from startTime + hours
	let endTime = $derived.by(() => {
		const [h, m] = ticket.startTime.split(':').map(Number);
		const totalMinutes = h * 60 + m + Math.round(ticket.hours * 60);
		const endH = Math.floor(totalMinutes / 60) % 24;
		const endM = totalMinutes % 60;
		return `${String(endH).padStart(2, '0')}:${String(endM).padStart(2, '0')}`;
	});

	const statusColors: Record<string, string> = {
		open: 'bg-amber-400',
		completed: 'bg-green-500',
		invoiced: 'bg-blue-500',
	};

	const statusTextColors: Record<string, string> = {
		open: 'text-amber-700 dark:text-amber-300 bg-amber-100 dark:bg-amber-900/30',
		completed: 'text-green-700 dark:text-green-300 bg-green-100 dark:bg-green-900/30',
		invoiced: 'text-blue-700 dark:text-blue-300 bg-blue-100 dark:bg-blue-900/30',
	};

	// Valid transitions for the dropdown
	const transitions: Record<string, TicketStatus[]> = {
		open: ['completed', 'invoiced'],
		completed: ['open', 'invoiced'],
		invoiced: [],
	};

	let availableTransitions = $derived(transitions[ticket.status] ?? []);

	function handleStatusSelect(status: TicketStatus) {
		statusMenuOpen = false;
		if (status === 'invoiced') {
			onToInvoice(ticket);
		} else {
			onStatusChange(ticket, status);
		}
	}
</script>

<div class="rounded-lg border border-border bg-bg-card overflow-hidden">
	<!-- Collapsed row -->
	<button
		class="w-full flex items-center gap-4 px-4 py-3 text-left hover:bg-bg/50 transition-colors"
		onclick={() => expanded = !expanded}
		aria-expanded={expanded}
	>
		<!-- Status dot -->
		<span class="flex-shrink-0 h-3 w-3 rounded-full {statusColors[ticket.status]}"></span>

		<!-- Ticket number + title -->
		<div class="flex-1 min-w-0">
			<div class="font-medium text-sm text-near-black truncate">{ticket.ticketNumber}{#if ticket.title} · {ticket.title}{/if}</div>
		</div>

		<!-- Client (hidden on mobile) -->
		<span class="hidden sm:inline text-sm text-near-black/60 truncate max-w-[150px]">{clientName}</span>

		<!-- Date + time range -->
		<span class="hidden md:inline text-sm text-near-black/60 tabular-nums whitespace-nowrap">
			{formatDate(ticket.date, dateFormat)} {formatTime(ticket.startTime)}–{formatTime(endTime)}
		</span>

		<!-- Hours + amount -->
		<span class="text-sm font-medium text-near-black tabular-nums whitespace-nowrap">
			{ticket.hours}h · {formatMoney(totalAmount, currency)}
		</span>

		<!-- Chevron -->
		<svg class="h-4 w-4 text-near-black/40 transition-transform {expanded ? 'rotate-180' : ''}" fill="none" stroke="currentColor" viewBox="0 0 24 24">
			<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 9l-7 7-7-7" />
		</svg>
	</button>

	{#if expanded}
		<div class="border-t border-border px-4 py-4 space-y-4">
			<!-- Mobile date/time -->
			<div class="md:hidden text-sm text-near-black/60">
				{formatDate(ticket.date, dateFormat)} {formatTime(ticket.startTime)}–{formatTime(endTime)}
			</div>

			<!-- Description -->
			{#if ticket.description}
				<div class="text-sm text-near-black prose prose-sm max-w-none dark:prose-invert pl-2 border-l-2 border-border">
					{@html ticket.description}
				</div>
			{/if}

			<!-- Notes -->
			{#if ticket.notes}
				<div class="text-sm text-near-black/70 bg-near-black/5 dark:bg-white/5 rounded px-3 py-2">
					<span class="font-medium">{t('ticket.notes')}:</span> {ticket.notes}
				</div>
			{/if}

			<!-- Details + Actions -->
			<div class="flex items-center gap-4 text-sm flex-wrap">
				<span class="text-near-black/60">{t('ticket.client')}: <span class="font-medium text-near-black">{clientName}</span></span>
				<span class="text-near-black/60">{t('ticket.hourlyRate')}: <span class="font-medium text-near-black">{formatMoney(ticket.hourlyRate, currency)}/h</span></span>

				<!-- Status dropdown -->
				<div class="relative">
					<button
						class="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium {statusTextColors[ticket.status]} {availableTransitions.length > 0 ? 'cursor-pointer hover:ring-1 hover:ring-current/30' : 'cursor-default'}"
						onclick={(e) => { e.stopPropagation(); if (availableTransitions.length > 0) statusMenuOpen = !statusMenuOpen; }}
						disabled={availableTransitions.length === 0}
					>
						{t(`status.${ticket.status}`)}
						{#if availableTransitions.length > 0}
							<svg class="h-3 w-3" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 9l-7 7-7-7" /></svg>
						{/if}
					</button>
					{#if statusMenuOpen}
						<!-- svelte-ignore a11y_no_static_element_interactions -->
						<div class="fixed inset-0 z-40" role="presentation" onclick={() => statusMenuOpen = false}></div>
						<div class="absolute left-0 top-full mt-1 z-50 w-36 rounded-lg border border-border bg-bg-card shadow-lg py-1">
							{#each availableTransitions as status}
								<button
									class="flex items-center gap-2 w-full px-3 py-1.5 text-sm text-near-black/80 hover:bg-bg/50 text-left"
									onclick={(e) => { e.stopPropagation(); handleStatusSelect(status); }}
								>
									<span class="h-2 w-2 rounded-full {statusColors[status]}"></span>
									{t(`status.${status}`)}
								</button>
							{/each}
						</div>
					{/if}
				</div>

				<div class="flex gap-1 ml-auto shrink-0">
					{#if ticket.status !== 'invoiced'}
						<Button variant="ghost" size="sm" onclick={() => onEdit(ticket)}>{t('action.edit')}</Button>
						<Button variant="ghost" size="sm" onclick={() => onToInvoice(ticket)}>{t('ticket.toInvoice')}</Button>
						<Button variant="danger" size="sm" onclick={() => onDelete(ticket)}>{t('action.delete')}</Button>
					{:else if ticket.invoiceId}
						<a href="/invoices/{ticket.invoiceId}" class="text-cyan hover:underline text-sm font-medium">{t('ticket.viewInvoice')}</a>
					{/if}
				</div>
			</div>
		</div>
	{/if}
</div>
