<script lang="ts">
	import { goto } from '$app/navigation';
	import { t } from '#lib/i18n/index.svelte.js';
	import { formatMoney } from '#lib/money.js';
	import Modal from '#components/ui/Modal.svelte';
	import Input from '#components/ui/Input.svelte';
	import Select from '#components/ui/Select.svelte';
	import MoneyInput from '#components/ui/MoneyInput.svelte';
	import RichTextArea from '#components/ui/RichTextArea.svelte';
	import TextArea from '#components/ui/TextArea.svelte';
	import Button from '#components/ui/Button.svelte';
	import type { Ticket } from '#lib/types.js';

	interface Props {
		open: boolean;
		ticket?: Ticket | null;
		clients: { id: string; name: string }[];
		currency?: string;
		onclose: () => void;
		onsave: (data: TicketFormData) => void;
	}

	export interface TicketFormData {
		title: string;
		description: string;
		clientId: string;
		date: string;
		startTime: string;
		hours: number;
		hourlyRate: number;
		notes: string;
	}

	let { open = $bindable(false), ticket = null, clients, currency = 'EUR', onclose, onsave }: Props = $props();

	let title = $state('');
	let description = $state('');
	let clientId = $state('');
	let date = $state('');
	let startTime = $state('09:00');
	let hours = $state(1);
	let hourlyRate = $state(0);
	let notes = $state('');
	let error = $state('');

	let clientOptions = $derived(
		clients.map(c => ({ value: c.id, label: c.name }))
	);
	let computedTotal = $derived(Math.round(hours * hourlyRate));

	$effect(() => {
		if (open) {
			if (ticket) {
				title = ticket.title || '';
				description = ticket.description;
				clientId = ticket.clientId;
				date = ticket.date;
				startTime = ticket.startTime;
				hours = ticket.hours;
				hourlyRate = ticket.hourlyRate;
				notes = ticket.notes;
			} else {
				title = '';
				description = '';
				clientId = clients.length === 1 ? clients[0].id : '';
				date = new Date().toISOString().split('T')[0];
				startTime = '09:00';
				hours = 1;
				notes = '';
				try {
					const saved = localStorage.getItem('itcake-last-hourly-rate');
					hourlyRate = saved ? Math.round(Number(saved)) || 0 : 0;
				} catch { hourlyRate = 0; }
			}
			error = '';
		}
	});

	function handleSave() {
		error = '';
		if (!clientId) { error = t('validation.selectClient'); return; }
		if (!date) { error = t('validation.required'); return; }
		if (hours <= 0) { error = t('validation.required'); return; }

		try { localStorage.setItem('itcake-last-hourly-rate', String(hourlyRate)); } catch { /* noop */ }

		onsave({
			title: title.trim(),
			description,
			clientId,
			date,
			startTime,
			hours,
			hourlyRate,
			notes: notes.trim()
		});
	}
</script>

<Modal {open} title={ticket ? t('ticket.edit') + ' ' + ticket.ticketNumber : t('ticket.new')} {onclose}>
	{#snippet children()}
		<div class="space-y-4">
			{#if error}
				<p class="text-sm text-bad dark:text-bad-300">{error}</p>
			{/if}

			<div>
				<Select label={t('ticket.client')} bind:value={clientId} options={[{ value: '', label: t('placeholder.selectClient') }, ...clientOptions]} required />
				<button type="button" class="text-xs text-brand hover:text-brand-ink mt-1 inline-block" onclick={() => { onclose(); goto('/clients/new'); }}>{t('misc.newClient')}</button>
			</div>

			<Input label={t('ticket.lineTitle')} bind:value={title} placeholder={t('ticket.lineTitlePlaceholder')} />

			<div class="grid grid-cols-2 gap-4">
				<Input label={t('ticket.date')} type="date" bind:value={date} required />
				<Input label={t('ticket.startTime')} type="time" bind:value={startTime} required />
			</div>

			<div class="grid grid-cols-2 gap-4">
				<Input label={t('ticket.hours')} type="number" bind:value={hours} min={0.01} max={24} step={0.25} required />
				<MoneyInput label={t('ticket.hourlyRate')} bind:value={hourlyRate} {currency} />
			</div>

			<!-- Computed total -->
			<div class="text-right text-sm text-ink/60">
				{t('ticket.total')}: <span class="font-semibold text-ink">{formatMoney(computedTotal, currency)}</span>
			</div>

			<RichTextArea label={t('ticket.description')} bind:value={description} rows={3} />

			<TextArea label={t('ticket.notes')} bind:value={notes} placeholder={t('placeholder.ticketNotes')} rows={2} />
		</div>
	{/snippet}
	{#snippet actions()}
		<Button variant="secondary" onclick={onclose}>{t('action.cancel')}</Button>
		<Button onclick={handleSave}>{ticket ? t('action.save') : t('action.create')}</Button>
	{/snippet}
</Modal>
