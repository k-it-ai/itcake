<script lang="ts">
	import { enhance } from '$app/forms';
	import TopBar from '$components/layout/TopBar.svelte';
	import Button from '$components/ui/Button.svelte';
	import Card from '$components/ui/Card.svelte';
	import Input from '$components/ui/Input.svelte';
	import TextArea from '$components/ui/TextArea.svelte';
	import Select from '$components/ui/Select.svelte';
	import Badge from '$components/ui/Badge.svelte';
	import ConfirmDialog from '$components/ui/ConfirmDialog.svelte';
	import { formatMoney } from '$lib/money.js';
	import { formatDate } from '$lib/format-date.js';
	import { currencySelectOptions } from '$lib/currencies.js';
	import { clientLanguageOptions, countrySelectOptions, invoiceBadgeVariant, proposalBadgeVariant } from '$lib/select-options.js';
	import { page } from '$app/state';
	import { t } from '$lib/i18n/index.svelte.js';
	import { useUnsavedWarning } from '$lib/unsaved-warning.svelte.js';
	import type { PageData, ActionData } from './$types.js';

	let { data, form }: { data: PageData; form: ActionData } = $props();
	let loading = $state(false);
	let showDelete = $state(false);
	let dateFormatVal = $derived(page.data?.settings?.general?.dateFormat || 'DD/MM/YYYY');
	const ticketStatusColors: Record<string, string> = { open: 'bg-amber-400', completed: 'bg-green-500', invoiced: 'bg-blue-500' };
	const dirty = useUnsavedWarning();

	let c = $derived(data.client);

	const currencyOptions = currencySelectOptions;

	let deleteForm = $state<HTMLFormElement>();
</script>

<svelte:head><title>{t('page.editClient', { name: c.name })} | ITCake</title></svelte:head>

<TopBar title={t('page.editClient', { name: c.name })} backHref="/clients">
	{#snippet children()}
		<Button variant="danger" size="sm" onclick={() => showDelete = true}>{t('action.delete')}</Button>
	{/snippet}
</TopBar>

<div class="p-6 max-w-3xl">
	{#if form?.error}
		<div role="alert" class="mb-4 rounded-lg bg-red/10 px-4 py-3 text-sm text-red-dark dark:text-red-300">{form.error}</div>
	{/if}

	<form method="POST" action="?/update" oninput={() => { dirty.value = true; }} use:enhance={() => {
		loading = true;
		return async ({ update }) => { loading = false; dirty.value = false; await update(); };
	}}>
		<Card class="space-y-6">
			<h2 class="text-lg font-semibold">{t('section.contactDetails')}</h2>
			<div class="grid grid-cols-1 gap-4 sm:grid-cols-2">
				<Input name="clientNumber" label={t('label.clientId')} value={c.clientNumber} />
				<Input name="name" label={t('label.clientName')} required value={c.name} />
				<Input name="contactPerson" label={t('label.contactPerson')} value={c.contactPerson} />
				<Input name="email" type="email" label={t('label.email')} required value={c.email} />
				<Input name="phone" label={t('label.phone')} value={c.phone} />
				<Input name="website" label={t('label.website')} value={c.website} />
			</div>

			<h2 class="text-lg font-semibold pt-4">{t('section.address')}</h2>
			<div class="grid grid-cols-1 gap-4 sm:grid-cols-2">
				<Input name="street" label={t('label.street')} required value={c.address?.street} class="sm:col-span-2" />
				<Input name="city" label={t('label.city')} required value={c.address?.city} />
				<Input name="zip" label={t('label.zipCode')} required value={c.address?.zip} />
				<Input name="state" label={t('label.state')} value={c.address?.state} />
				<Select name="country" label={t('label.country')} required options={countrySelectOptions()} value={c.address?.country} />
			</div>

			<h2 class="text-lg font-semibold pt-4">{t('section.businessDetails')}</h2>
			<div class="grid grid-cols-1 gap-4 sm:grid-cols-2">
				<Input name="vatNumber" label={t('label.vatNumber')} value={c.vatNumber} />
				<Input name="registrationNumber" label={t('label.registrationNumber')} value={c.registrationNumber} />
				<Select name="language" label={t('label.language')} options={clientLanguageOptions()} value={c.language} />
				<Select name="currency" label={t('label.currency')} options={currencyOptions} value={c.currency} />
				<Input name="paymentTermDays" type="number" label={t('label.paymentTermDays')} value={String(c.paymentTermDays)} />
			</div>

			<TextArea name="notes" label={t('label.notes')} value={c.notes} />

			<div class="flex justify-end gap-3 pt-4">
				<a href="/clients"><Button type="button" variant="secondary">{t('action.cancel')}</Button></a>
				<Button type="submit" {loading}>{t('button.saveChanges')}</Button>
			</div>
		</Card>
	</form>

	<!-- Related documents -->
	<Card class="mt-6">
		<div class="flex items-center justify-between mb-4">
			<h2 class="text-lg font-semibold">{t('invoice.titlePlural')} ({data.invoices.length})</h2>
			<a href="/invoices/new?clientId={c.id}">
				<Button size="sm" variant="secondary">+ {t('invoice.new')}</Button>
			</a>
		</div>
		{#if data.invoices.length > 0}
			<div class="space-y-1">
				{#each data.invoices as inv}
					<a href="/invoices/{inv.id}" class="flex items-center justify-between py-2 px-2 rounded hover:bg-bg/50 -mx-2">
						<span class="text-sm font-medium">{inv.documentId}</span>
						<div class="flex items-center gap-3">
							<span class="text-sm tabular-nums">{formatMoney(inv.totals.total, inv.currency)}</span>
							<Badge variant={invoiceBadgeVariant(inv.status)}>{t('status.' + inv.status)}</Badge>
						</div>
					</a>
				{/each}
			</div>
		{:else}
			<p class="text-sm text-near-black/60">{t('empty.noInvoicesForClient')}</p>
		{/if}
	</Card>

	<Card class="mt-4">
		<div class="flex items-center justify-between mb-4">
			<h2 class="text-lg font-semibold">{t('proposal.titlePlural')} ({data.proposals.length})</h2>
			<a href="/proposals/new">
				<Button size="sm" variant="secondary">+ {t('proposal.new')}</Button>
			</a>
		</div>
		{#if data.proposals.length > 0}
			<div class="space-y-1">
				{#each data.proposals as prop}
					<a href="/proposals/{prop.id}" class="flex items-center justify-between py-2 px-2 rounded hover:bg-bg/50 -mx-2">
						<span class="text-sm font-medium">{prop.documentId}</span>
						<div class="flex items-center gap-3">
							<span class="text-sm tabular-nums">{formatMoney(prop.totals.total, prop.currency)}</span>
							<Badge variant={proposalBadgeVariant(prop.status)}>{t('status.' + prop.status)}</Badge>
						</div>
					</a>
				{/each}
			</div>
		{:else}
			<p class="text-sm text-near-black/60">{t('empty.noProposalsForClient')}</p>
		{/if}
	</Card>

	<Card class="mt-4">
		<h2 class="text-lg font-semibold mb-4">{t('ticket.titlePlural')} ({data.tickets.length})</h2>
		{#if data.tickets.length > 0}
			<div class="space-y-1">
				{#each data.tickets as ticket}
					<div class="flex items-center justify-between py-2 px-2 rounded -mx-2">
						<div class="flex items-center gap-2">
							<span class="h-2.5 w-2.5 rounded-full shrink-0 {ticketStatusColors[ticket.status] ?? 'bg-near-black/30'}"></span>
							<span class="text-sm font-medium">{ticket.ticketNumber}</span>
							{#if ticket.title}<span class="text-sm text-near-black/60 truncate max-w-[200px]">{ticket.title}</span>{/if}
						</div>
						<div class="flex items-center gap-3">
							<span class="text-xs text-near-black/50">{formatDate(ticket.date, dateFormatVal)}</span>
							<span class="text-sm tabular-nums">{ticket.hours}h</span>
							<span class="text-sm font-medium tabular-nums">{formatMoney(Math.round(ticket.hours * ticket.hourlyRate), c.currency ?? 'EUR')}</span>
						</div>
					</div>
				{/each}
			</div>
		{:else}
			<p class="text-sm text-near-black/60">{t('empty.noTicketsForClient')}</p>
		{/if}
	</Card>
</div>

<ConfirmDialog
	bind:open={showDelete}
	title={t('dialog.deleteClient')}
	message={t('dialog.deleteClientMessage', { name: c.name, extra: data.invoices.length > 0 ? t('dialog.clientHasInvoices', { count: data.invoices.length }) : '' })}
	confirmLabel={t('action.delete')}
	onconfirm={() => deleteForm?.requestSubmit()}
	oncancel={() => showDelete = false}
/>

<form bind:this={deleteForm} method="POST" action="?/delete" class="hidden" use:enhance></form>
