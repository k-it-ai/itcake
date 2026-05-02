<script lang="ts">
	import { t } from '$lib/i18n/index.svelte.js';
	import { formatMoney } from '$lib/money.js';
	import { onMount } from 'svelte';
	import dayjs from 'dayjs';
	import type { Ticket } from '$lib/types.js';

	type CalendarMode = 'day' | '3day' | 'week';

	interface Props {
		tickets: Ticket[];
		clients: { id: string; name: string }[];
		mode?: CalendarMode;
		currency?: string;
		lang?: string;
		onTicketClick?: (ticket: Ticket) => void;
	}

	let { tickets, clients, mode = 'week', currency = 'EUR', lang = 'en', onTicketClick }: Props = $props();

	let scrollContainer = $state<HTMLDivElement>();

	function formatHourLabel(hour: number): string {
		if (lang === 'en') {
			const suffix = hour >= 12 ? 'PM' : 'AM';
			const h12 = hour % 12 || 12;
			return `${h12} ${suffix}`;
		}
		return `${String(hour).padStart(2, '0')}:00`;
	}

	let anchorDate = $state(dayjs());

	const START_HOUR = 6;
	const END_HOUR = 22;
	const SLOT_HEIGHT = 20; // px per 15-min slot
	const TOTAL_SLOTS = (END_HOUR - START_HOUR) * 4;

	let dayCount = $derived(mode === 'day' ? 1 : mode === '3day' ? 3 : 7);

	onMount(() => {
		const now = dayjs();
		const currentHour = now.hour();
		if (currentHour >= START_HOUR && currentHour < END_HOUR && scrollContainer) {
			const slotsFromTop = (currentHour - START_HOUR - 1) * 4; // scroll to 1h before current
			scrollContainer.scrollTop = Math.max(0, slotsFromTop * SLOT_HEIGHT);
		}
	});

	let visibleDates = $derived.by(() => {
		const dates: dayjs.Dayjs[] = [];
		let start = anchorDate;
		if (mode === 'week') {
			const dow = anchorDate.day();
			start = dow === 0 ? anchorDate.subtract(6, 'day') : anchorDate.subtract(dow - 1, 'day');
		}
		for (let i = 0; i < dayCount; i++) {
			dates.push(start.add(i, 'day'));
		}
		return dates;
	});

	let ticketsByDate = $derived.by(() => {
		const map = new Map<string, Ticket[]>();
		for (const d of visibleDates) {
			const key = d.format('YYYY-MM-DD');
			map.set(key, []);
		}
		for (const ticket of tickets) {
			const arr = map.get(ticket.date);
			if (arr) arr.push(ticket);
		}
		return map;
	});

	let dailyTotals = $derived.by(() => {
		const totals = new Map<string, number>();
		for (const [date, dateTickets] of ticketsByDate) {
			totals.set(date, dateTickets.reduce((sum, t) => sum + t.hours, 0));
		}
		return totals;
	});

	function clientName(clientId: string): string {
		return clients.find(c => c.id === clientId)?.name ?? '';
	}

	function getGridRow(ticket: Ticket): { start: number; end: number } {
		const [h, m] = ticket.startTime.split(':').map(Number);
		const rawSlot = (h - START_HOUR) * 4 + Math.floor(m / 15);
		const startSlot = Math.max(0, rawSlot); // clamp: before START_HOUR → top of grid
		const durationSlots = Math.max(1, Math.round(ticket.hours * 4));
		const adjustedDuration = rawSlot < 0 ? durationSlots + rawSlot : durationSlots;
		if (adjustedDuration <= 0) return { start: 2, end: 3 }; // entirely before visible range — show minimal
		return {
			start: startSlot + 2, // +2 for header row (1-indexed grid)
			end: Math.min(startSlot + adjustedDuration + 2, TOTAL_SLOTS + 2)
		};
	}

	const statusBorderColors: Record<string, string> = {
		open: 'border-l-amber-400 bg-amber-50 dark:bg-amber-900/20',
		completed: 'border-l-green-500 bg-green-50 dark:bg-green-900/20',
		invoiced: 'border-l-blue-500 bg-blue-50 dark:bg-blue-900/20',
	};

	function prev() {
		if (mode === 'week') anchorDate = anchorDate.subtract(7, 'day');
		else anchorDate = anchorDate.subtract(dayCount, 'day');
	}
	function next() {
		if (mode === 'week') anchorDate = anchorDate.add(7, 'day');
		else anchorDate = anchorDate.add(dayCount, 'day');
	}
	function goToday() { anchorDate = dayjs(); }

	let hourLabels = $derived.by(() => {
		const labels: { hour: number; slot: number }[] = [];
		for (let h = START_HOUR; h < END_HOUR; h++) {
			labels.push({ hour: h, slot: (h - START_HOUR) * 4 + 2 });
		}
		return labels;
	});
</script>

<!-- Navigation -->
<div class="flex items-center gap-2 mb-4">
	<button onclick={prev} class="p-1.5 rounded hover:bg-near-black/10 text-near-black/60 hover:text-near-black transition-colors" aria-label={t('misc.previous')}>
		<svg class="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24" stroke-width="2"><path stroke-linecap="round" stroke-linejoin="round" d="M15 19l-7-7 7-7" /></svg>
	</button>
	<button onclick={goToday} class="px-3 py-1 text-sm font-medium rounded border border-border hover:bg-near-black/5 text-near-black transition-colors">{t('ticket.today')}</button>
	<button onclick={next} class="p-1.5 rounded hover:bg-near-black/10 text-near-black/60 hover:text-near-black transition-colors" aria-label={t('misc.next')}>
		<svg class="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24" stroke-width="2"><path stroke-linecap="round" stroke-linejoin="round" d="M9 5l7 7-7 7" /></svg>
	</button>
	<span class="text-sm font-medium text-near-black ml-2">
		{visibleDates[0].format('MMM D')}
		{#if dayCount > 1}
			– {visibleDates[dayCount - 1].format('MMM D, YYYY')}
		{:else}
			, {visibleDates[0].format('YYYY')}
		{/if}
	</span>
</div>

<!-- Calendar grid — scrollable, auto-scrolls to current hour -->
<div bind:this={scrollContainer} class="overflow-x-auto overflow-y-auto border border-border rounded-lg bg-bg-card" style="max-height: 75vh;">
	<div
		class="grid min-w-[400px]"
		style="grid-template-columns: 50px repeat({dayCount}, 1fr); grid-template-rows: auto repeat({TOTAL_SLOTS}, 20px);"
	>
		<!-- Header: time gutter + date columns -->
		<div class="sticky top-0 z-10 bg-bg-card border-b border-border"></div>
		{#each visibleDates as d, i}
			<div class="sticky top-0 z-10 bg-bg-card border-b border-border {i > 0 ? 'border-l' : ''} px-2 py-2 text-center">
				<div class="text-xs text-near-black/50">{d.format('ddd')}</div>
				<div class="text-sm font-semibold text-near-black {d.isSame(dayjs(), 'day') ? 'text-cyan' : ''}">{d.format('D')}</div>
				{#if (dailyTotals.get(d.format('YYYY-MM-DD')) ?? 0) > 0}
					<div class="text-[10px] text-near-black/50">{dailyTotals.get(d.format('YYYY-MM-DD'))}h</div>
				{/if}
			</div>
		{/each}

		<!-- Time labels (left gutter) -->
		{#each hourLabels as { hour, slot }}
			<div
				class="text-[10px] text-near-black/40 text-right pr-1 leading-none"
				style="grid-row: {slot}; grid-column: 1;"
			>
				{formatHourLabel(hour)}
			</div>
		{/each}

		<!-- Hour gridlines -->
		{#each hourLabels as { slot }, i}
			{#each visibleDates as _, colIdx}
				<div
					class="border-t border-border/50 {colIdx > 0 ? 'border-l border-l-border/30' : ''}"
					style="grid-row: {slot}; grid-column: {colIdx + 2};"
				></div>
			{/each}
		{/each}

		<!-- Ticket blocks -->
		{#each visibleDates as d, colIdx}
			{@const dateKey = d.format('YYYY-MM-DD')}
			{@const dateTickets = ticketsByDate.get(dateKey) ?? []}
			{#each dateTickets as ticket}
				{@const pos = getGridRow(ticket)}
				<button
					class="mx-0.5 rounded border-l-4 px-1.5 py-1 text-left overflow-hidden cursor-pointer hover:shadow-sm transition-shadow flex flex-col items-start {statusBorderColors[ticket.status]}"
					style="grid-row: {pos.start} / {pos.end}; grid-column: {colIdx + 2};"
					onclick={() => onTicketClick?.(ticket)}
					title="{ticket.ticketNumber}{ticket.title ? ' · ' + ticket.title : ''} · {clientName(ticket.clientId)} · {ticket.hours}h"
				>
					<div class="text-[10px] text-near-black/50 leading-tight w-full">{ticket.ticketNumber}</div>
					<div class="text-[11px] font-semibold text-near-black truncate leading-tight w-full">{ticket.title || clientName(ticket.clientId)}</div>
					<div class="text-[10px] text-near-black/60 truncate leading-tight w-full">{clientName(ticket.clientId)}</div>
				</button>
			{/each}
		{/each}
	</div>
</div>
