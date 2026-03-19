<script lang="ts">
	import { tick } from 'svelte';
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

	// Valid transitions for the status dot dropdown
	const transitions: Record<string, TicketStatus[]> = {
		open: ['completed', 'invoiced'],
		completed: ['open', 'invoiced'],
		invoiced: [],
	};

	let availableTransitions = $derived(transitions[ticket.status] ?? []);
	let statusMenuIndex = $state(-1);
	let statusTrigger = $state<HTMLButtonElement>();
	let menuItems = $state<HTMLButtonElement[]>([]);

	function handleStatusSelect(status: TicketStatus) {
		statusMenuOpen = false;
		statusMenuIndex = -1;
		statusTrigger?.focus();
		if (status === 'invoiced') {
			onToInvoice(ticket);
		} else {
			onStatusChange(ticket, status);
		}
	}

	function openStatusMenu() {
		if (availableTransitions.length === 0) return;
		statusMenuOpen = true;
		statusMenuIndex = 0;
		// Focus first menu item after DOM update
		tick().then(() => menuItems[0]?.focus());
	}

	function closeStatusMenu() {
		statusMenuOpen = false;
		statusMenuIndex = -1;
		statusTrigger?.focus();
	}

	function handleMenuKeydown(e: KeyboardEvent) {
		if (e.key === 'Escape') {
			e.preventDefault();
			closeStatusMenu();
		} else if (e.key === 'ArrowDown') {
			e.preventDefault();
			statusMenuIndex = (statusMenuIndex + 1) % availableTransitions.length;
			menuItems[statusMenuIndex]?.focus();
		} else if (e.key === 'ArrowUp') {
			e.preventDefault();
			statusMenuIndex = (statusMenuIndex - 1 + availableTransitions.length) % availableTransitions.length;
			menuItems[statusMenuIndex]?.focus();
		} else if (e.key === 'Home') {
			e.preventDefault();
			statusMenuIndex = 0;
			menuItems[0]?.focus();
		} else if (e.key === 'End') {
			e.preventDefault();
			statusMenuIndex = availableTransitions.length - 1;
			menuItems[statusMenuIndex]?.focus();
		} else if (e.key === 'Tab') {
			closeStatusMenu();
		}
	}

	function handleTriggerKeydown(e: KeyboardEvent) {
		if (e.key === 'ArrowDown' || e.key === 'Enter' || e.key === ' ') {
			e.preventDefault();
			e.stopPropagation();
			openStatusMenu();
		}
	}
</script>

<div class="rounded-lg border border-border bg-bg-card">
	<!-- Collapsed row -->
	<div class="flex items-center gap-4 px-4 py-3 hover:bg-bg/50 transition-colors">
		<!-- Status dot (clickable to change status) -->
		<div class="relative flex-shrink-0">
			{#if availableTransitions.length > 0}
				<button
					bind:this={statusTrigger}
					class="group/dot flex items-center gap-1 rounded-md px-1 py-1 -mx-1 -my-1 cursor-pointer hover:bg-near-black/5 dark:hover:bg-white/10 transition-colors"
					onclick={(e) => { e.stopPropagation(); statusMenuOpen ? closeStatusMenu() : openStatusMenu(); }}
					onkeydown={(e) => { e.stopPropagation(); handleTriggerKeydown(e); }}
					aria-haspopup="true"
					aria-expanded={statusMenuOpen}
					aria-label={t('aria.changeStatus', { status: t(`status.${ticket.status}`) })}
				>
					<span class="h-3 w-3 rounded-full {statusColors[ticket.status]} flex-shrink-0"></span>
					<svg class="h-3 w-3 text-near-black/40 opacity-0 group-hover/dot:opacity-100 transition-opacity" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 9l-7 7-7-7" /></svg>
				</button>
			{:else}
				<span class="h-3 w-3 rounded-full {statusColors[ticket.status]} block"></span>
			{/if}
			{#if statusMenuOpen}
				<!-- svelte-ignore a11y_no_static_element_interactions -->
				<div class="fixed inset-0 z-40" role="presentation" aria-hidden="true" onclick={() => closeStatusMenu()}></div>
				<div
					class="absolute left-0 top-full mt-2 z-50 w-44 rounded-lg border border-border bg-bg-card shadow-lg py-1"
					role="menu"
					tabindex="-1"
					aria-label={t('aria.statusMenu')}
					onkeydown={handleMenuKeydown}
				>
					{#each availableTransitions as status, i}
						<button
							bind:this={menuItems[i]}
							class="flex items-center gap-2.5 w-full px-3 py-2 text-sm text-near-black/80 hover:bg-bg/50 text-left {statusMenuIndex === i ? 'bg-bg/50' : ''}"
							role="menuitem"
							tabindex={statusMenuIndex === i ? 0 : -1}
							onclick={() => handleStatusSelect(status)}
						>
							<span class="h-2.5 w-2.5 rounded-full {statusColors[status]} flex-shrink-0" aria-hidden="true"></span>
							<span class="flex-1">{t(`status.${status}`)}</span>
						</button>
					{/each}
				</div>
			{/if}
		</div>

		<!-- Expand/collapse button for the rest of the row -->
		<button
			class="flex-1 flex items-center gap-3 sm:gap-4 text-left min-w-0"
			onclick={() => expanded = !expanded}
			aria-expanded={expanded}
			aria-label={t('aria.expandTicket', { number: ticket.ticketNumber })}
		>
			<!-- Ticket number + title -->
			<div class="min-w-0 flex-1">
				<span class="font-medium text-sm text-near-black truncate block">{ticket.ticketNumber}{#if ticket.title} · {ticket.title}{/if}</span>
			</div>

			<!-- Client -->
			<span class="hidden sm:inline text-xs text-near-black/50 whitespace-nowrap">{t('ticket.client')}:</span>
			<span class="hidden sm:inline text-sm text-near-black/70 truncate max-w-[120px]">{clientName}</span>

			<!-- Date + time -->
			<span class="hidden md:inline text-xs text-near-black/50 whitespace-nowrap">{t('ticket.time')}:</span>
			<span class="hidden md:inline text-sm text-near-black/70 tabular-nums whitespace-nowrap">
				{formatDate(ticket.date, dateFormat)} {formatTime(ticket.startTime)}–{formatTime(endTime)}
			</span>

			<!-- Hours + amount -->
			<span class="text-sm font-medium text-near-black tabular-nums whitespace-nowrap">
				{ticket.hours}h · {formatMoney(totalAmount, currency)}
			</span>

			<!-- Chevron -->
			<svg class="h-4 w-4 text-near-black/40 flex-shrink-0 transition-transform {expanded ? 'rotate-180' : ''}" fill="none" stroke="currentColor" viewBox="0 0 24 24">
				<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 9l-7 7-7-7" />
			</svg>
		</button>
	</div>

	{#if expanded}
		<div class="border-t border-border px-4 py-4 space-y-4">
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
