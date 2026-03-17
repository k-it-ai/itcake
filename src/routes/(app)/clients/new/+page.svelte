<script lang="ts">
	import { enhance } from '$app/forms';
	import TopBar from '$components/layout/TopBar.svelte';
	import Button from '$components/ui/Button.svelte';
	import Card from '$components/ui/Card.svelte';
	import Input from '$components/ui/Input.svelte';
	import TextArea from '$components/ui/TextArea.svelte';
	import Select from '$components/ui/Select.svelte';
	import { currencySelectOptions } from '$lib/currencies.js';
	import { clientLanguageOptions, countrySelectOptions } from '$lib/select-options.js';
	import { t } from '$lib/i18n/index.svelte.js';
	import type { PageData, ActionData } from './$types.js';

	let { data, form }: { data: PageData; form: ActionData } = $props();
	let loading = $state(false);

	const currencyOptions = currencySelectOptions;
</script>

<svelte:head><title>{t('page.newClient')} | ITCake</title></svelte:head>

<TopBar title={t('client.new')}>
	{#snippet children()}
		<a href="/clients" class="text-sm text-near-black/60 hover:text-near-black">{t('action.cancel')}</a>
	{/snippet}
</TopBar>

<div class="p-6 max-w-3xl">
	{#if form?.error}
		<div role="alert" class="mb-4 rounded-lg bg-red/10 px-4 py-3 text-sm text-red-dark dark:text-red-300">{form.error}</div>
	{/if}

	<form method="POST" use:enhance={() => {
		loading = true;
		return async ({ update }) => { loading = false; await update(); };
	}}>
		<Card class="space-y-6">
			<h2 class="text-lg font-semibold">{t('section.contactDetails')}</h2>
			<div class="grid grid-cols-1 gap-4 sm:grid-cols-2">
				<Input name="clientNumber" label={t('label.clientId')} value={data.nextClientNumber} />
				<Input name="name" label={t('label.clientName')} required placeholder="Acme Corp" />
				<Input name="contactPerson" label={t('label.contactPerson')} placeholder="John Doe" />
				<Input name="email" type="email" label={t('label.email')} placeholder="info@acme.com" />
				<Input name="phone" label={t('label.phone')} placeholder="+1 234 567 890" />
				<Input name="website" label={t('label.website')} placeholder="https://acme.com" />
			</div>

			<h2 class="text-lg font-semibold pt-4">{t('section.address')}</h2>
			<div class="grid grid-cols-1 gap-4 sm:grid-cols-2">
				<Input name="street" label={t('label.street')} placeholder="123 Main St" class="sm:col-span-2" />
				<Input name="city" label={t('label.city')} placeholder="Amsterdam" />
				<Input name="zip" label={t('label.zipCode')} placeholder="1000 AA" />
				<Input name="state" label={t('label.state')} />
				<Select name="country" label={t('label.country')} options={countrySelectOptions()} />
			</div>

			<h2 class="text-lg font-semibold pt-4">{t('section.businessDetails')}</h2>
			<div class="grid grid-cols-1 gap-4 sm:grid-cols-2">
				<Input name="vatNumber" label={t('label.vatNumber')} placeholder="NL123456789B01" />
				<Input name="registrationNumber" label={t('label.registrationNumber')} placeholder="12345678" />
				<Select name="language" label={t('label.language')} options={clientLanguageOptions()} value={data.defaults.language} />
				<Select name="currency" label={t('label.currency')} options={currencyOptions} value={data.defaults.currency} />
				<Input name="paymentTermDays" type="number" label={t('label.paymentTermDays')} value={String(data.defaults.paymentTermDays)} />
			</div>

			<TextArea name="notes" label={t('label.notes')} placeholder={t('placeholder.additionalNotes')} />

			<div class="flex justify-end gap-3 pt-4">
				<a href="/clients"><Button type="button" variant="secondary">{t('action.cancel')}</Button></a>
				<Button type="submit" {loading}>{t('button.createClient')}</Button>
			</div>
		</Card>
	</form>
</div>
