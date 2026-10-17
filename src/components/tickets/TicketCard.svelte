<script lang="ts">
	import { page } from '$app/state';
	import { t } from '#lib/i18n/index.svelte.js';
	import { formatDate } from '#lib/format-date.js';
	import { formatMoney } from '#lib/money.js';
	import type { Ticket, TicketStatus } from '#lib/types.js';
	import Btn from '#lib/components/ui/Btn.svelte';

	let dateFormat = $derived(page.data?.settings?.general?.dateFormat || 'DD/MM/YYYY');
	let currency = $derived(page.data?.settings?.general?.currency || 'EUR');

	interface Props {
		ticket: Ticket;
		clients: { id: string; name: string }[];
		onEdit: (ticket: Ticket) => void;
		onDelete: (ticket: Ticket) => void;
		onStatusChange: (ticket: Ticket, status: TicketStatus) => void;
		onToInvoice: (ticket: Ticket) => void;
	}

	let { ticket, clients, onEdit, onDelete, onStatusChange, onToInvoice }: Props = $props();

	let expanded = $state(false);
	let dropdownOpen = $state(false);

	const statusColors: Record<string, string> = {
		open: 'bg-amber-400',
		completed: 'bg-green-500',
		invoiced: 'bg-blue-500',
	};

	let clientName = $derived(clients.find(c => c.id === ticket.clientId)?.name ?? '—');
	let totalAmount = $derived(Math.round(ticket.hours * ticket.hourlyRate));

	function formatTime(t: string) { return t?.slice(0, 5) || ''; }

	let endTime = $derived.by(() => {
		if (!ticket.startTime) return '';
		const [h, m] = ticket.startTime.split(':').map(Number);
		const totalMin = h * 60 + m + Math.round(ticket.hours * 60);
		return `${String(Math.floor(totalMin / 60) % 24).padStart(2, '0')}:${String(totalMin % 60).padStart(2, '0')}`;
	});
</script>

<div class="rounded-lg border border-line bg-card">
	<!-- Collapsed row (entire row clickable to expand) -->
	<!-- svelte-ignore a11y_no_static_element_interactions -->
	<!-- svelte-ignore a11y_click_events_have_key_events -->
	<div
		class="flex items-center gap-3 px-4 py-3 cursor-pointer hover:bg-bg/50 transition-colors"
		onclick={() => expanded = !expanded}
		role="button"
		tabindex="0"
		aria-expanded={expanded}
		aria-label={t('aria.expandTicket', { number: ticket.ticketNumber })}
		onkeydown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); expanded = !expanded; } }}
	>
		<!-- Static status dot -->
		<span class="h-3 w-3 rounded-full shrink-0 {statusColors[ticket.status] ?? 'bg-near-black/30'}"></span>

		<!-- Content -->
		<div class="flex-1 flex items-center gap-3 min-w-0">
			<!-- Ticket number + title -->
			<div class="min-w-0 flex-1">
				<span class="font-medium text-sm text-ink truncate block">{ticket.ticketNumber}{#if ticket.title}<span class="mx-1 text-ink/40">&bull;</span>{ticket.title}{/if}</span>
				<span class="text-xs text-ink/50 truncate block sm:hidden">{clientName}</span>
			</div>

			<!-- Client (desktop) -->
			<span class="hidden sm:inline text-sm text-ink/70 truncate max-w-[140px]">{clientName}</span>

			<!-- Date (desktop) -->
			<span class="hidden md:inline text-sm text-ink/60 tabular-nums whitespace-nowrap">
				{formatDate(ticket.date, dateFormat)}
			</span>

			<!-- Hours + amount -->
			<span class="text-sm font-medium text-ink tabular-nums whitespace-nowrap">
				{ticket.hours}h · {formatMoney(totalAmount, currency)}
			</span>

			<!-- Chevron -->
			<svg class="h-4 w-4 text-ink/40 shrink-0 transition-transform {expanded ? 'rotate-180' : ''}" fill="none" stroke="currentColor" viewBox="0 0 24 24">
				<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 9l-7 7-7-7" />
			</svg>
		</div>
	</div>

	{#if expanded}
		<div class="border-t border-line px-4 py-4 space-y-4">
			<!-- Description -->
			{#if ticket.description}
				<div class="text-sm text-ink max-w-none [&_ul]:list-disc [&_ul]:pl-5 [&_ol]:list-decimal [&_ol]:pl-5 [&_p]:mb-1 [&_li]:mb-0.5">
					{@html ticket.description}
				</div>
			{/if}

			<!-- Notes -->
			{#if ticket.notes}
				<div class="text-sm text-ink/70 bg-near-black/5 dark:bg-white/5 rounded px-3 py-2">
					<span class="font-medium">{t('ticket.notes')}:</span> {ticket.notes}
				</div>
			{/if}

			<!-- Details grid -->
			<div class="grid grid-cols-2 sm:grid-cols-4 gap-x-4 gap-y-2 text-sm">
				<div>
					<span class="text-[10px] uppercase tracking-wide text-ink/50">{t('ticket.client')}</span>
					<div class="font-medium text-ink mt-0.5">{clientName}</div>
				</div>
				<div>
					<span class="text-[10px] uppercase tracking-wide text-ink/50">{t('ticket.hourlyRate')}</span>
					<div class="font-medium text-ink mt-0.5 tabular-nums">{formatMoney(ticket.hourlyRate, currency)}/h</div>
				</div>
				<div>
					<span class="text-[10px] uppercase tracking-wide text-ink/50">{t('ticket.total')}</span>
					<div class="font-medium text-ink mt-0.5 tabular-nums">{formatMoney(totalAmount, currency)}</div>
				</div>
				<div>
					<span class="text-[10px] uppercase tracking-wide text-ink/50">{t('ticket.time')}</span>
					<div class="font-medium text-ink mt-0.5 tabular-nums">{formatDate(ticket.date, dateFormat)} {formatTime(ticket.startTime)}–{formatTime(endTime)}</div>
				</div>
			</div>

			<!-- Actions bar -->
			<div class="flex items-center justify-end gap-2 pt-3 mt-1 border-t border-line">
				{#if ticket.status === 'open'}
					<Btn variant="ghost" size="sm" onclick={() => onEdit(ticket)}>{t('action.edit')}</Btn>
					<Btn variant="ghost" size="sm" onclick={() => onStatusChange(ticket, 'completed')}>{t('status.completed')}</Btn>
					<Btn variant="dangerSoft" size="sm" onclick={() => onDelete(ticket)}>{t('action.delete')}</Btn>
				{:else if ticket.status === 'completed'}
					<Btn variant="ghost" size="sm" onclick={() => onEdit(ticket)}>{t('action.edit')}</Btn>
					<!-- Abrechnen with dropdown arrow for "Offen" -->
					<div class="relative">
						<div class="flex">
							<Btn variant="ghost" size="sm" onclick={() => onToInvoice(ticket)} class="rounded-r-none border-r-0">{t('ticket.toInvoice')}</Btn>
							<button
								class="flex items-center px-1.5 rounded-r-lg border border-line bg-card hover:bg-bg transition-colors text-ink/60"
								onclick={() => dropdownOpen = !dropdownOpen}
								aria-haspopup="true"
								aria-expanded={dropdownOpen}
								aria-label={t('aria.moreOptions')}
							>
								<svg class="h-3.5 w-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 9l-7 7-7-7" /></svg>
							</button>
						</div>
						{#if dropdownOpen}
							<!-- svelte-ignore a11y_no_static_element_interactions -->
							<div class="fixed inset-0 z-40" role="presentation" aria-hidden="true" onclick={() => dropdownOpen = false}></div>
							<div class="absolute right-0 top-full mt-1 z-50 w-36 rounded-lg border border-line bg-card shadow-lg py-1" role="menu">
								<button
									class="flex items-center gap-2 w-full px-3 py-1.5 text-sm text-ink/80 hover:bg-bg/50 text-left"
									role="menuitem"
									onclick={() => { dropdownOpen = false; onStatusChange(ticket, 'open'); }}
								>
									<span class="h-2.5 w-2.5 rounded-full bg-amber-400 shrink-0"></span>
									{t('status.open')}
								</button>
							</div>
						{/if}
					</div>
					<Btn variant="dangerSoft" size="sm" onclick={() => onDelete(ticket)}>{t('action.delete')}</Btn>
				{:else if ticket.invoiceId}
					<a href="/invoices/{ticket.invoiceId}" class="text-brand hover:underline text-sm font-medium">{t('ticket.viewInvoice')}</a>
				{/if}
			</div>
		</div>
	{/if}
</div>
