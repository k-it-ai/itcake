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
	import { t } from '$lib/i18n/index.svelte.js';
	import { useUnsavedWarning } from '$lib/unsaved-warning.svelte.js';
	import { currencySelectOptions } from '$lib/currencies.js';
	import type { LineItem, Discount } from '$lib/types.js';
	import type { PageData, ActionData } from './$types.js';

	let { data, form }: { data: PageData; form: ActionData } = $props();

	const dirty = useUnsavedWarning();
	let loading = $state(false);
	let clientId = $state('');
	let pricingMode = $state<'net' | 'gross'>(data.defaults.defaultPricingMode);
	let currency = $state(data.defaultCurrency ?? 'EUR');
	let language = $state(data.defaultLanguage ?? 'en');
	let issueDate = $state(new Date().toISOString().split('T')[0]);
	let validUntil = $state(
		new Date(Date.now() + data.defaults.defaultValidDays * 86400000).toISOString().split('T')[0]
	);
	let items = $state<LineItem[]>([]);
	let discounts = $state<Discount[]>([]);
	let introText = $state('');
	let notes = $state(data.defaults.defaultNotes);
	let footerText = $state(data.defaults.defaultFooter);
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

	const initialNotes = data.defaults.defaultNotes;
	const initialFooter = data.defaults.defaultFooter;
	$effect(() => {
		void [clientId, items.length, introText, notes, footerText];
		dirty.value = clientId !== '' || items.length > 0 || introText !== '' || notes !== initialNotes || footerText !== initialFooter;
	});

	function handleSubmit() {
		if (loading) return;
		if (!clientId) { toast(t('validation.selectClient'), 'error'); return; }
		if (items.length === 0) { toast(t('validation.addItems'), 'error'); return; }

		if (!dataInput || !submitForm) return;
		dirty.value = false;
		dataInput.value = JSON.stringify({
			clientId, pricingMode, currency, language,
			issueDate, validUntil, items, discounts,
			introText, notes, footerText, templateId: 'itcake', templateOptions: {}
		});
		submitForm.requestSubmit();
	}
</script>

<svelte:head><title>{t('page.newProposal')} | ITCake</title></svelte:head>

<TopBar
	title={t('proposal.new')}
	breadcrumb={[t('crumb.billing'), t('proposal.titlePlural'), t('proposal.new')]}
>
	{#snippet right()}
		<Btn variant="ghost" size="sm" href="/proposals">{t('action.cancel')}</Btn>
		<Btn
			variant="primary"
			size="sm"
			disabled={loading || !clientId || items.length === 0}
			onclick={handleSubmit}
		>{t('button.createProposal')}</Btn>
	{/snippet}
</TopBar>

<div class="p-5 pb-20 lg:pb-5">
	{#if form?.error}
		<div role="alert" class="mb-4 rounded-md px-3 py-2 text-[12.5px]" style="background:var(--bad-soft);color:#7a1a22">
			{form.error}
		</div>
	{/if}

	{#if data.kleinunternehmer}
		<div class="mb-4 rounded-md px-3 py-2 text-[12.5px]" style="background:var(--brand-soft);color:var(--brand-ink)">
			{t('info.kleinunternehmer')}
		</div>
	{/if}

	<div class="grid grid-cols-1 gap-4 lg:grid-cols-3">
		<div class="space-y-4 lg:col-span-2">
			<Card padding={20}>
				<SectionHead title={t('section.proposalDetails')} />
				<div class="grid grid-cols-1 gap-4 sm:grid-cols-2">
					<div>
						<Select label={t('label.client')} required bind:value={clientId}
							options={[{ value: '', label: t('placeholder.selectClient') }, ...clientOptions]} />
						<a href="/clients/new" class="mt-1 inline-block text-[11.5px] underline" style="color:var(--brand-ink)">{t('misc.newClient')}</a>
					</div>
					<Select label={t('label.pricingMode')} bind:value={pricingMode}
						options={[{ value: 'net', label: t('option.netExclTax') }, { value: 'gross', label: t('option.grossInclTax') }]} />
					<Select label={t('label.currency')} bind:value={currency} options={currencyOptions} />
					<Input type="date" label={t('label.issueDate')} bind:value={issueDate} />
					<Input type="date" label={t('label.validUntil')} bind:value={validUntil} />
				</div>
			</Card>

			<Card padding={20}>
				<RichTextArea label={t('label.introduction')} bind:value={introText} rows={3} placeholder={t('placeholder.introduction')} />
			</Card>

			<Card padding={20}>
				<SectionHead title={t('section.lineItems')} />
				<LineItemEditor bind:items {currency} defaultTaxRate={data.kleinunternehmer ? 0 : data.defaults.defaultTaxRate} catalogItems={data.catalogItems} />
			</Card>

			<Card padding={20}>
				<SectionHead title={t('section.discounts')} />
				<DiscountEditor bind:discounts {currency} />
			</Card>

			<Card padding={20}>
				<div class="space-y-4">
					<RichTextArea label={t('label.notes')} bind:value={notes} rows={3} />
					<RichTextArea label={t('label.footer')} bind:value={footerText} rows={2} />
				</div>
			</Card>
		</div>

		<div>
			<Card padding={20}>
				<SectionHead title={t('section.summary')} />
				<InvoiceSummary {items} {discounts} {pricingMode} {currency} />
				<div class="mt-6">
					<Btn
						variant="primary"
						class="w-full justify-center"
						disabled={loading || !clientId || items.length === 0}
						onclick={handleSubmit}
					>{t('button.createProposal')}</Btn>
				</div>
			</Card>
		</div>
	</div>
</div>

<div class="fixed bottom-4 left-4 right-4 z-30 lg:hidden">
	<Btn
		variant="primary"
		class="w-full justify-center shadow-pop"
		disabled={loading || !clientId || items.length === 0}
		onclick={handleSubmit}
	>{t('button.createProposal')}</Btn>
</div>

<form
	bind:this={submitForm}
	method="POST"
	class="hidden"
	use:enhance={() => {
		loading = true;
		return async ({ result, update }) => {
			loading = false;
			if (result.type === 'redirect') toast(t('toast.proposalCreated'));
			else if (result.type === 'error') toast(t('toast.networkError'), 'error');
			await update();
		};
	}}
>
	<input bind:this={dataInput} name="data" type="hidden" />
</form>
