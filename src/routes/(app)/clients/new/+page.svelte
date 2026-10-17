<script lang="ts">
	import { enhance } from '$app/forms';
	import TopBar from '#lib/components/shell/TopBar.svelte';
	import Btn from '#lib/components/ui/Btn.svelte';
	import Card from '#lib/components/ui/Card.svelte';
	import SectionHead from '#lib/components/ui/SectionHead.svelte';
	import Input from '#components/ui/Input.svelte';
	import TextArea from '#components/ui/TextArea.svelte';
	import Select from '#components/ui/Select.svelte';
	import { currencySelectOptions } from '#lib/currencies.js';
	import { clientLanguageOptions, countrySelectOptions } from '#lib/select-options.js';
	import { t } from '#lib/i18n/index.svelte.js';
	import type { PageData, ActionData } from './$types.js';

	let { data, form }: { data: PageData; form: ActionData } = $props();
	let loading = $state(false);

	const currencyOptions = currencySelectOptions;
</script>

<svelte:head><title>{t('page.newClient')} | ITCake</title></svelte:head>

<TopBar
	title={t('client.new')}
	breadcrumb={[t('crumb.workspace'), t('client.titlePlural'), t('client.new')]}
>
	{#snippet right()}
		<Btn variant="ghost" size="sm" href="/clients">{t('action.cancel')}</Btn>
	{/snippet}
</TopBar>

<div class="p-5">
	<form method="POST" use:enhance={() => {
		loading = true;
		return async ({ update }) => { loading = false; await update(); };
	}}>
		<div class="mx-auto max-w-3xl space-y-4">
			{#if form?.error}
				<div role="alert" class="rounded-md px-3 py-2 text-[12.5px]" style="background:var(--bad-soft);color:#7a1a22">
					{form.error}
				</div>
			{/if}

			<Card padding={20}>
				<SectionHead title={t('section.contactDetails')} />
				<div class="grid grid-cols-1 gap-4 sm:grid-cols-2">
					<Input name="clientNumber" label={t('label.clientId')} value={data.nextClientNumber} />
					<Input name="name" label={t('label.clientName')} required placeholder={t('placeholder.clientNameExample')} />
					<Input name="contactPerson" label={t('label.contactPerson')} placeholder={t('placeholder.contactPersonExample')} />
					<Input name="email" type="email" label={t('label.email')} required placeholder={t('placeholder.clientEmailExample')} />
					<Input name="phone" label={t('label.phone')} placeholder={t('placeholder.phoneNumber')} />
					<Input name="website" label={t('label.website')} placeholder={t('placeholder.websiteExample')} />
				</div>
			</Card>

			<Card padding={20}>
				<SectionHead title={t('section.address')} />
				<div class="grid grid-cols-1 gap-4 sm:grid-cols-2">
					<Input name="street" label={t('label.street')} required placeholder={t('placeholder.streetAddress')} class="sm:col-span-2" />
					<Input name="city" label={t('label.city')} required placeholder={t('placeholder.cityExample')} />
					<Input name="zip" label={t('label.zipCode')} required placeholder={t('placeholder.zipCodeExample')} />
					<Input name="state" label={t('label.state')} />
					<Select name="country" label={t('label.country')} required options={countrySelectOptions()} />
				</div>
			</Card>

			<Card padding={20}>
				<SectionHead title={t('section.businessDetails')} />
				<div class="grid grid-cols-1 gap-4 sm:grid-cols-2">
					<Input name="vatNumber" label={t('label.vatNumber')} placeholder={t('placeholder.vatExample')} />
					<Input name="registrationNumber" label={t('label.registrationNumber')} placeholder="12345678" />
					<Select name="language" label={t('label.language')} options={clientLanguageOptions()} value={data.defaults.language} />
					<Select name="currency" label={t('label.currency')} options={currencyOptions} value={data.defaults.currency} />
					<Input name="paymentTermDays" type="number" label={t('label.paymentTermDays')} value={String(data.defaults.paymentTermDays)} />
				</div>
				<div class="mt-4">
					<TextArea name="notes" label={t('label.notes')} placeholder={t('placeholder.additionalNotes')} />
				</div>
			</Card>

			<div class="flex justify-end gap-2 pt-2">
				<Btn variant="ghost" size="md" href="/clients">{t('action.cancel')}</Btn>
				<Btn variant="primary" size="md" type="submit" disabled={loading}>{t('button.createClient')}</Btn>
			</div>
		</div>
	</form>
</div>
