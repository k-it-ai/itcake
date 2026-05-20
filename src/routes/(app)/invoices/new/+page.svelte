<script lang="ts">
	import { enhance } from '$app/forms';
	import TopBar from '$lib/components/shell/TopBar.svelte';
	import Btn from '$lib/components/ui/Btn.svelte';
	import Card from '$lib/components/ui/Card.svelte';
	import SectionHead from '$lib/components/ui/SectionHead.svelte';
	import Input from '$components/ui/Input.svelte';
	import Select from '$components/ui/Select.svelte';
	import RichTextArea from '$components/ui/RichTextArea.svelte';
	import LineItemEditor from '$components/forms/LineItemEditor.svelte';
	import DiscountEditor from '$components/forms/DiscountEditor.svelte';
	import InvoiceSummary from '$components/invoice/InvoiceSummary.svelte';
	import { toast } from '$components/ui/Toast.svelte';
	import Toggle from '$lib/components/ui/Toggle.svelte';
	import { t } from '$lib/i18n/index.svelte.js';
	import { useUnsavedWarning } from '$lib/unsaved-warning.svelte.js';
	import dayjs from 'dayjs';
	import { currencySelectOptions } from '$lib/currencies.js';
	import type { LineItem, Discount, RecurringFrequency } from '$lib/types.js';
	import type { PageData, ActionData } from './$types.js';

	let { data, form }: { data: PageData; form: ActionData } = $props();

	const dirty = useUnsavedWarning();
	let loading = $state(false);
	let clientId = $state(data.prefillClientId || '');
	let pricingMode = $state<'net' | 'gross'>(data.defaults.defaultPricingMode);
	let currency = $state(data.defaultCurrency ?? 'EUR');
	let language = $state(data.defaultLanguage ?? 'en');
	let issueDate = $state(new Date().toISOString().split('T')[0]);
	let dueDate = $state(
		new Date(Date.now() + data.defaults.defaultPaymentTermDays * 86400000).toISOString().split('T')[0]
	);
	let dueDateManuallySet = $state(false);
	let items = $state<LineItem[]>([]);
	let discounts = $state<Discount[]>([]);
	let notes = $state(data.defaults.defaultNotes);
	let footerText = $state(data.defaults.defaultFooter);
	let recurringEnabled = $state(false);
	let recurringFrequency = $state<RecurringFrequency>('monthly');
	let recurringCustomDays = $state(30);
	let recurringEndDate = $state('');

	const clientOptions = data.clients.map((c) => ({ value: c.id, label: c.name }));
	const currencyOptions = currencySelectOptions;

	let dataInput = $state<HTMLInputElement>();
	let submitForm = $state<HTMLFormElement>();

	$effect(() => {
		if (clientId) {
			const client = data.clients.find((c) => c.id === clientId);
			if (client) {
				currency = client.currency || 'EUR';
				language = client.language || 'en';
			}
		}
	});

	const initialClientId = data.prefillClientId || '';
	const initialNotes = data.defaults.defaultNotes;
	const initialFooter = data.defaults.defaultFooter;
	$effect(() => {
		void [clientId, items.length, notes, footerText];
		dirty.value = clientId !== initialClientId || items.length > 0 || notes !== initialNotes || footerText !== initialFooter;
	});

	$effect(() => {
		if (issueDate && !dueDateManuallySet) {
			dueDate = dayjs(issueDate).add(data.defaults.defaultPaymentTermDays, 'day').format('YYYY-MM-DD');
		}
	});

	function handleSubmit() {
		if (loading) return;
		if (!clientId) { toast(t('validation.selectClient'), 'error'); return; }
		if (items.length === 0) { toast(t('validation.addItems'), 'error'); return; }

		const recurring = recurringEnabled ? {
			enabled: true,
			frequency: recurringFrequency,
			customIntervalDays: recurringFrequency === 'custom' ? recurringCustomDays : null,
			nextRunDate: issueDate,
			endDate: recurringEndDate || null,
			lastRunDate: null,
			generatedInvoiceIds: []
		} : null;

		if (!dataInput || !submitForm) return;
		dirty.value = false;
		dataInput.value = JSON.stringify({
			clientId, pricingMode, currency, language,
			issueDate, dueDate,
			items, discounts,
			notes, footerText, templateId: 'kossov-it', templateOptions: {},
			recurring
		});
		submitForm.requestSubmit();
	}
</script>

<svelte:window onkeydown={(e) => {
	if ((e.metaKey || e.ctrlKey) && e.key === 's') {
		e.preventDefault();
		handleSubmit();
	}
}} />
<svelte:head><title>{t('page.newInvoice')} | ITCake</title></svelte:head>

<TopBar
	title={t('invoice.new')}
	breadcrumb={['Billing', t('invoice.titlePlural'), t('invoice.new')]}
>
	{#snippet right()}
		<Btn variant="ghost" size="sm" href="/invoices">{t('action.cancel')}</Btn>
		<Btn variant="primary" size="sm" disabled={loading || !clientId || items.length === 0} onclick={handleSubmit}>{t('button.createInvoice')}</Btn>
	{/snippet}
</TopBar>

<div class="p-5 pb-20 lg:pb-5">
	{#if form?.error}
		<div role="alert" class="mb-4 rounded-md px-4 py-3 text-[12.5px]" style="background:var(--bad-soft);color:#7a1a22">{form.error}</div>
	{/if}

	{#if data.kleinunternehmer}
		<div class="mb-4 rounded-md px-4 py-3 text-[12.5px]" style="background:var(--brand-soft);color:var(--brand-ink)">{t('info.kleinunternehmer')}</div>
	{/if}

	<div class="grid grid-cols-1 gap-5 lg:grid-cols-3">
		<!-- Main form -->
		<div class="lg:col-span-2 space-y-5">
			<Card padding={20} class="space-y-4">
				<SectionHead title={t('section.invoiceDetails')} />

				<div class="grid grid-cols-1 gap-4 sm:grid-cols-2">
					<div>
						<Select name="client" label={t('label.client')} required autofocus bind:value={clientId}
							options={[{ value: '', label: t('placeholder.selectClient') }, ...clientOptions]} />
						<a href="/clients/new" class="text-[11px] mt-1 inline-block" style="color:var(--brand)">{t('misc.newClient')}</a>
					</div>
					<Select name="pricingMode" label={t('label.pricingMode')} bind:value={pricingMode}
						options={[{ value: 'net', label: t('option.netExclTax') }, { value: 'gross', label: t('option.grossInclTax') }]} />
					<Select name="currency" label={t('label.currency')} bind:value={currency} options={currencyOptions} />
					<Input name="issueDate" type="date" label={t('label.issueDate')} bind:value={issueDate} />
					<Input name="dueDate" type="date" label={t('label.dueDate')} bind:value={dueDate} onchange={() => dueDateManuallySet = true} />
				</div>
			</Card>

			<Card padding={20}>
				<SectionHead title={t('section.lineItems')} />
				<LineItemEditor bind:items {currency} defaultTaxRate={data.kleinunternehmer ? 0 : data.defaults.defaultTaxRate} catalogItems={data.catalogItems} />
			</Card>

			<Card padding={20} class="space-y-4">
				<SectionHead title={t('section.discounts')} />
				<DiscountEditor bind:discounts {currency} />
			</Card>

			<Card padding={20} class="space-y-4">
				<RichTextArea label={t('label.notes')} bind:value={notes} rows={3} placeholder={t('placeholder.notes')} />
				<RichTextArea label={t('label.footer')} bind:value={footerText} rows={2} placeholder={t('placeholder.footer')} />
			</Card>

			<Card padding={20} class="space-y-4">
				<SectionHead title={t('section.recurringInvoice')}>
					{#snippet right()}
						<Toggle bind:checked={recurringEnabled} label={t('label.enableRecurring')} />
					{/snippet}
				</SectionHead>
				{#if recurringEnabled}
					<div class="grid grid-cols-1 gap-4 sm:grid-cols-2">
						<Select label={t('label.frequency')} bind:value={recurringFrequency}
							options={[
								{ value: 'weekly', label: t('option.weekly') },
								{ value: 'monthly', label: t('option.monthly') },
								{ value: 'quarterly', label: t('option.quarterly') },
								{ value: 'yearly', label: t('option.yearly') },
								{ value: 'custom', label: t('option.customInterval') }
							]} />
						{#if recurringFrequency === 'custom'}
							<Input type="number" label={t('label.customInterval')} bind:value={recurringCustomDays} />
						{/if}
						<Input type="date" label={t('label.endDate')} bind:value={recurringEndDate} />
					</div>
					<p class="text-[11px]" style="color:var(--muted)">{t('help.recurringAutoGenerate')}</p>
				{/if}
			</Card>
		</div>

		<!-- Sidebar summary -->
		<div>
			<Card padding={20}>
				<SectionHead title={t('section.summary')} />
				<InvoiceSummary {items} {discounts} {pricingMode} {currency} />

				<div class="mt-6">
					<Btn class="w-full justify-center" variant="primary" disabled={loading || !clientId || items.length === 0} onclick={handleSubmit}>{t('button.createInvoice')}</Btn>
				</div>
			</Card>
		</div>
	</div>
</div>

<!-- Floating create button on mobile -->
<div class="fixed bottom-4 left-4 right-4 z-30 lg:hidden">
	<Btn class="w-full justify-center shadow-pop" variant="primary" disabled={loading || !clientId || items.length === 0} onclick={handleSubmit}>{t('button.createInvoice')}</Btn>
</div>

<form
	bind:this={submitForm}
	method="POST"
	class="hidden"
	use:enhance={() => {
		loading = true;
		return async ({ result, update }) => {
			loading = false;
			if (result.type === 'redirect') {
				toast(t('toast.invoiceCreated'));
			} else if (result.type === 'error') {
				toast(t('toast.networkError'), 'error');
			}
			await update();
		};
	}}
>
	<input bind:this={dataInput} name="data" type="hidden" />
</form>
