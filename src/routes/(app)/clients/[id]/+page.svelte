<script lang="ts">
	import { enhance } from '$app/forms';
	import TopBar from '#lib/components/shell/TopBar.svelte';
	import Btn from '#lib/components/ui/Btn.svelte';
	import Card from '#lib/components/ui/Card.svelte';
	import SectionHead from '#lib/components/ui/SectionHead.svelte';
	import StatusPill from '#lib/components/ui/StatusPill.svelte';
	import Dot from '#lib/components/ui/Dot.svelte';
	import Avatar from '#lib/components/ui/Avatar.svelte';
	import Input from '#components/ui/Input.svelte';
	import TextArea from '#components/ui/TextArea.svelte';
	import Select from '#components/ui/Select.svelte';
	import ConfirmDialog from '#components/ui/ConfirmDialog.svelte';
	import { Plus } from '#lib/icons/index.js';
	import { formatMoney } from '#lib/money.js';
	import { formatDate } from '#lib/format-date.js';
	import { currencySelectOptions } from '#lib/currencies.js';
	import { clientLanguageOptions, countrySelectOptions, invoiceStatusTone, proposalStatusTone } from '#lib/select-options.js';
	import { page } from '$app/state';
	import { t } from '#lib/i18n/index.svelte.js';
	import { useUnsavedWarning } from '#lib/unsaved-warning.svelte.js';
	import type { PageData, ActionData } from './$types.js';

	let { data, form }: { data: PageData; form: ActionData } = $props();
	let loading = $state(false);
	let showDelete = $state(false);
	let dateFormatVal = $derived(page.data?.settings?.general?.dateFormat || 'DD/MM/YYYY');
	const ticketDotTone: Record<string, 'warn' | 'good' | 'brand' | 'mute'> = {
		open: 'warn',
		completed: 'good',
		invoiced: 'brand'
	};
	const dirty = useUnsavedWarning();

	let c = $derived(data.client);

	const currencyOptions = currencySelectOptions;

	let deleteForm = $state<HTMLFormElement>();
</script>

<svelte:head><title>{t('page.editClient', { name: c.name })} | ITCake</title></svelte:head>

<TopBar
	title={c.name}
	breadcrumb={[t('crumb.workspace'), t('client.titlePlural'), c.name]}
	sub={c.address?.city ?? undefined}
>
	{#snippet right()}
		<Btn variant="dangerSoft" size="sm" onclick={() => showDelete = true}>{t('action.delete')}</Btn>
	{/snippet}
</TopBar>

<div class="p-5">
	<form method="POST" action="?/update" oninput={() => { dirty.value = true; }} use:enhance={() => {
		loading = true;
		return async ({ update }) => { loading = false; dirty.value = false; await update(); };
	}}>
		<div class="mx-auto max-w-3xl space-y-4">
			{#if form?.error}
				<div role="alert" class="rounded-md px-3 py-2 text-[12.5px]" style="background:var(--bad-soft);color:#7a1a22">
					{form.error}
				</div>
			{/if}

			<Card padding={20}>
				<div class="mb-3 flex items-center gap-2.5">
					<Avatar name={c.name} size={28} />
					<SectionHead title={t('section.contactDetails')} class="!mb-0 flex-1" />
				</div>
				<div class="grid grid-cols-1 gap-4 sm:grid-cols-2">
					<Input name="clientNumber" label={t('label.clientId')} value={c.clientNumber} />
					<Input name="name" label={t('label.clientName')} required value={c.name} />
					<Input name="contactPerson" label={t('label.contactPerson')} value={c.contactPerson} />
					<Input name="email" type="email" label={t('label.email')} required value={c.email} />
					<Input name="phone" label={t('label.phone')} value={c.phone} />
					<Input name="website" label={t('label.website')} value={c.website} />
				</div>
			</Card>

			<Card padding={20}>
				<SectionHead title={t('section.address')} />
				<div class="grid grid-cols-1 gap-4 sm:grid-cols-2">
					<Input name="street" label={t('label.street')} required value={c.address?.street} class="sm:col-span-2" />
					<Input name="city" label={t('label.city')} required value={c.address?.city} />
					<Input name="zip" label={t('label.zipCode')} required value={c.address?.zip} />
					<Input name="state" label={t('label.state')} value={c.address?.state} />
					<Select name="country" label={t('label.country')} required options={countrySelectOptions()} value={c.address?.country} />
				</div>
			</Card>

			<Card padding={20}>
				<SectionHead title={t('section.businessDetails')} />
				<div class="grid grid-cols-1 gap-4 sm:grid-cols-2">
					<Input name="vatNumber" label={t('label.vatNumber')} value={c.vatNumber} />
					<Input name="registrationNumber" label={t('label.registrationNumber')} value={c.registrationNumber} />
					<Select name="language" label={t('label.language')} options={clientLanguageOptions()} value={c.language} />
					<Select name="currency" label={t('label.currency')} options={currencyOptions} value={c.currency} />
					<Input name="paymentTermDays" type="number" label={t('label.paymentTermDays')} value={String(c.paymentTermDays)} />
				</div>
				<div class="mt-4">
					<TextArea name="notes" label={t('label.notes')} value={c.notes} />
				</div>
			</Card>

			<div class="flex justify-end gap-2 pt-2">
				<Btn variant="ghost" size="md" href="/clients">{t('action.cancel')}</Btn>
				<Btn variant="primary" size="md" type="submit" disabled={loading}>{t('button.saveChanges')}</Btn>
			</div>
		</div>
	</form>

	<!-- Related documents -->
	<div class="mx-auto mt-6 max-w-3xl space-y-4">
		<Card padding={20}>
			<SectionHead title="{t('invoice.titlePlural')} ({data.invoices.length})">
				{#snippet right()}
					<Btn variant="soft" size="sm" href="/invoices/new?clientId={c.id}">
						{#snippet icon()}<Plus size={14} strokeWidth={1.6} />{/snippet}
						{t('invoice.new')}
					</Btn>
				{/snippet}
			</SectionHead>
			{#if data.invoices.length > 0}
				<div class="-mx-2 divide-y" style="border-color:var(--line-2)">
					{#each data.invoices as inv (inv.id)}
						<a href="/invoices/{inv.id}" class="flex items-center justify-between rounded px-2 py-2 transition-colors hover:bg-[#fbfcfd]" style="border-color:var(--line-2)">
							<span class="text-[12.5px] font-medium num" style="font-family:ui-monospace,SFMono-Regular,Menlo,monospace;color:var(--ink)">{inv.documentId}</span>
							<div class="flex items-center gap-3">
								<span class="text-[12.5px] tabular-nums" style="color:var(--ink)">{formatMoney(inv.totals.total, inv.currency)}</span>
								<StatusPill tone={invoiceStatusTone(inv.status)} action={false}>{t('status.' + inv.status)}</StatusPill>
							</div>
						</a>
					{/each}
				</div>
			{:else}
				<p class="text-[12.5px]" style="color:var(--muted)">{t('empty.noInvoicesForClient')}</p>
			{/if}
		</Card>

		<Card padding={20}>
			<SectionHead title="{t('proposal.titlePlural')} ({data.proposals.length})">
				{#snippet right()}
					<Btn variant="soft" size="sm" href="/proposals/new">
						{#snippet icon()}<Plus size={14} strokeWidth={1.6} />{/snippet}
						{t('proposal.new')}
					</Btn>
				{/snippet}
			</SectionHead>
			{#if data.proposals.length > 0}
				<div class="-mx-2 divide-y" style="border-color:var(--line-2)">
					{#each data.proposals as prop (prop.id)}
						<a href="/proposals/{prop.id}" class="flex items-center justify-between rounded px-2 py-2 transition-colors hover:bg-[#fbfcfd]" style="border-color:var(--line-2)">
							<span class="text-[12.5px] font-medium num" style="font-family:ui-monospace,SFMono-Regular,Menlo,monospace;color:var(--ink)">{prop.documentId}</span>
							<div class="flex items-center gap-3">
								<span class="text-[12.5px] tabular-nums" style="color:var(--ink)">{formatMoney(prop.totals.total, prop.currency)}</span>
								<StatusPill tone={proposalStatusTone(prop.status)} action={false}>{t('status.' + prop.status)}</StatusPill>
							</div>
						</a>
					{/each}
				</div>
			{:else}
				<p class="text-[12.5px]" style="color:var(--muted)">{t('empty.noProposalsForClient')}</p>
			{/if}
		</Card>

		<Card padding={20}>
			<SectionHead title="{t('ticket.titlePlural')} ({data.tickets.length})" />
			{#if data.tickets.length > 0}
				<div class="-mx-2 divide-y" style="border-color:var(--line-2)">
					{#each data.tickets as ticket (ticket.id)}
						<div class="flex items-center justify-between rounded px-2 py-2" style="border-color:var(--line-2)">
							<div class="flex items-center gap-2">
								<Dot tone={ticketDotTone[ticket.status] ?? 'mute'} />
								<span class="text-[12.5px] font-medium num" style="font-family:ui-monospace,SFMono-Regular,Menlo,monospace;color:var(--ink)">{ticket.ticketNumber}</span>
								{#if ticket.title}<span class="max-w-[200px] truncate text-[12.5px]" style="color:var(--muted)">{ticket.title}</span>{/if}
							</div>
							<div class="flex items-center gap-3">
								<span class="text-[11px]" style="color:var(--muted)">{formatDate(ticket.date, dateFormatVal)}</span>
								<span class="text-[12.5px] tabular-nums" style="color:var(--ink)">{ticket.hours}h</span>
								<span class="text-[12.5px] font-medium tabular-nums" style="color:var(--ink)">{formatMoney(Math.round(ticket.hours * ticket.hourlyRate), c.currency ?? 'EUR')}</span>
							</div>
						</div>
					{/each}
				</div>
			{:else}
				<p class="text-[12.5px]" style="color:var(--muted)">{t('empty.noTicketsForClient')}</p>
			{/if}
		</Card>
	</div>
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
