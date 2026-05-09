<script lang="ts">
	import { enhance } from '$app/forms';
	import Btn from '$lib/components/ui/Btn.svelte';
	import Input from '$components/ui/Input.svelte';
	import Select from '$components/ui/Select.svelte';
	import Card from '$lib/components/ui/Card.svelte';
	import { currencySelectOptions } from '$lib/currencies.js';
	import { interfaceLanguageOptions, countrySelectOptions, dateFormatOptions } from '$lib/select-options.js';
	import { theme } from '$lib/stores/theme.svelte.js';
	import { t } from '$lib/i18n/index.svelte.js';
	import type { ActionData } from './$types.js';

	let { form }: { form: ActionData } = $props();
	let loading = $state(false);
	let step = $state(1);
	let stepError = $state('');
	let showPassword = $state(false);
	let showBankDetails = $state(false);

	let userName = $state('');
	let userEmail = $state('');
	let userPassword = $state('');
	let companyName = $state('');

	const stepKeys = ['setup.step1Title', 'setup.step2Title', 'setup.step3Title'] as const;

	const currencyOptions = currencySelectOptions;

	function validateStep(n: number): boolean {
		stepError = '';
		if (n === 1) {
			if (!userName.trim() || !userEmail.trim() || !userPassword) { stepError = t('validation.fillAllFields'); return false; }
			if (userPassword.length < 8) { stepError = t('validation.passwordMin'); return false; }
		}
		if (n === 2) {
			if (!companyName.trim()) { stepError = t('validation.companyNameRequired'); return false; }
		}
		return true;
	}

	function nextStep() {
		if (validateStep(step)) {
			step++;
			stepError = '';
		}
	}
</script>

<div class="relative flex min-h-screen items-center justify-center bg-bg px-4">
	<button
		onclick={() => theme.toggle()}
		class="absolute top-4 right-4 rounded-lg p-2 text-near-black/50 hover:text-near-black hover:bg-bg-card transition-colors"
		aria-label={t('aria.toggleTheme')}
	>
		{#if theme.value === 'dark'}
			<svg class="h-5 w-5" fill="none" stroke="currentColor" viewBox="0 0 24 24" stroke-width="1.5"><path stroke-linecap="round" stroke-linejoin="round" d="M12 3v2.25m6.364.386l-1.591 1.591M21 12h-2.25m-.386 6.364l-1.591-1.591M12 18.75V21m-4.773-4.227l-1.591 1.591M5.25 12H3m4.227-4.773L5.636 5.636M15.75 12a3.75 3.75 0 11-7.5 0 3.75 3.75 0 017.5 0z" /></svg>
		{:else}
			<svg class="h-5 w-5" fill="none" stroke="currentColor" viewBox="0 0 24 24" stroke-width="1.5"><path stroke-linecap="round" stroke-linejoin="round" d="M21.752 15.002A9.718 9.718 0 0118 15.75c-5.385 0-9.75-4.365-9.75-9.75 0-1.33.266-2.597.748-3.752A9.753 9.753 0 003 11.25C3 16.635 7.365 21 12.75 21a9.753 9.753 0 009.002-5.998z" /></svg>
		{/if}
	</button>
	<Card class="w-full max-w-lg">
		<div class="text-center mb-6">
			<h1 class="text-2xl font-bold text-near-black">{t('setup.welcome')}</h1>
			<p class="mt-2 text-sm text-near-black/60">{t('setup.subtitle')}</p>
		</div>

		<!-- Step indicator -->
		<div class="flex items-center justify-center gap-2 mb-8">
			{#each stepKeys as s, i}
				<div class="flex items-center gap-2">
					<div class="flex items-center justify-center h-7 w-7 rounded-full text-xs font-bold transition-colors
						{i + 1 < step ? 'bg-cyan text-white' : i + 1 === step ? 'bg-cyan text-white' : 'bg-bg border border-border text-near-black/60'}">
						{#if i + 1 < step}
							<svg class="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24" stroke-width="2"><path stroke-linecap="round" stroke-linejoin="round" d="M5 13l4 4L19 7" /></svg>
						{:else}
							{i + 1}
						{/if}
					</div>
					<span class="text-xs font-medium {i + 1 === step ? 'text-near-black' : 'text-near-black/60'}">{t(s)}</span>
					{#if i < stepKeys.length - 1}
						<div class="w-8 h-px {i + 1 < step ? 'bg-cyan' : 'bg-border'}"></div>
					{/if}
				</div>
			{/each}
		</div>

		{#if form?.error}
			<div role="alert" class="mb-4 rounded-lg bg-red/10 px-4 py-3 text-sm text-red-dark dark:text-red-300">{form.error}</div>
		{/if}
		{#if stepError}
			<div role="alert" class="mb-4 rounded-lg bg-red/10 px-4 py-3 text-sm text-red-dark dark:text-red-300">{stepError}</div>
		{/if}

		<!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
		<form method="POST" use:enhance={() => {
			loading = true;
			return async ({ update }) => { loading = false; await update(); };
		}} onkeydown={(e) => { if (e.key === 'Enter' && step < 3) { e.preventDefault(); nextStep(); } }}>
			<!-- Step 1: Admin Account -->
			<div class:hidden={step !== 1}>
				<div class="space-y-4">
					<h2 class="text-lg font-semibold">{t('setup.account')}</h2>
					<Input name="name" label={t('setup.fullName')} required placeholder={t('placeholder.yourName')} bind:value={userName} />
					<Input name="email" type="email" label={t('setup.email')} required placeholder={t('placeholder.emailExample')} bind:value={userEmail} />
					<div class="relative">
						<Input name="password" type={showPassword ? 'text' : 'password'} label={t('setup.password')} required placeholder={t('setup.passwordHint')} minlength={8} autocomplete="new-password" bind:value={userPassword} />
						<button type="button" class="absolute right-3 top-[2.15rem] text-near-black/50 hover:text-near-black text-xs" onclick={() => showPassword = !showPassword} aria-label={showPassword ? t('action.hide') : t('action.show')}>
							{showPassword ? t('action.hide') : t('action.show')}
						</button>
					</div>
				</div>
				<div class="mt-6">
					<Btn type="button" class="w-full" onclick={nextStep}>{t('action.next')}</Btn>
				</div>
			</div>

			<!-- Step 2: Company Info -->
			<div class:hidden={step !== 2}>
				<div class="space-y-4">
					<h2 class="text-lg font-semibold">{t('setup.company')}</h2>
					<Input name="companyName" label={t('setup.companyName')} required placeholder={t('placeholder.yourCompany')} bind:value={companyName} />
					<div class="grid grid-cols-2 gap-4">
						<Input name="companyEmail" type="email" label={t('settings.companyEmail')} placeholder={t('placeholder.companyEmail')} />
						<Input name="companyPhone" label={t('settings.companyPhone')} placeholder={t('placeholder.phoneNumber')} />
					</div>
					<div class="grid grid-cols-2 gap-4">
						<Input name="companyTaxNumber" label={t('settings.taxNumber')} placeholder={t('placeholder.taxNumber')} />
						<Input name="companyVat" label={t('settings.vatId')} placeholder={t('placeholder.vatExample')} />
					</div>
					<Input name="companyStreet" label={t('settings.street')} placeholder={t('placeholder.streetAddress')} />
					<div class="grid grid-cols-1 sm:grid-cols-3 gap-4">
						<Input name="companyCity" label={t('settings.city')} placeholder={t('placeholder.cityExample')} />
						<Input name="companyZip" label={t('settings.zip')} placeholder={t('placeholder.zipCodeExample')} />
						<Select name="companyCountry" label={t('settings.country')} value="NL" options={countrySelectOptions()} />
					</div>

					<button type="button" class="flex items-center gap-2 font-medium py-2 text-near-black/70 hover:text-near-black transition-colors" onclick={() => showBankDetails = !showBankDetails} aria-expanded={showBankDetails}>
						<svg class="h-4 w-4 transition-transform {showBankDetails ? 'rotate-90' : ''}" fill="none" stroke="currentColor" viewBox="0 0 24 24" stroke-width="2"><path stroke-linecap="round" stroke-linejoin="round" d="M9 5l7 7-7 7" /></svg>
						{t('settings.bankDetails')} <span class="text-xs text-near-black/50 font-normal">({t('misc.optional')})</span>
					</button>
					{#if showBankDetails}
						<div class="grid grid-cols-2 gap-4">
							<Input name="bankName" label={t('settings.bankName')} placeholder={t('placeholder.bankNameExample')} />
							<Input name="bankAccount" label={t('settings.accountHolder')} placeholder={t('placeholder.accountHolderExample')} />
						</div>
						<div class="grid grid-cols-2 gap-4">
							<Input name="bankIban" label={t('settings.iban')} placeholder={t('placeholder.ibanExample')} />
							<Input name="bankSwift" label={t('settings.bic')} placeholder={t('placeholder.swiftExample')} />
						</div>
					{/if}
				</div>
				<div class="mt-6 flex gap-3">
					<Btn type="button" variant="ghost" onclick={() => step = 1}>{t('action.back')}</Btn>
					<Btn type="button" class="flex-1" onclick={nextStep}>{t('action.next')}</Btn>
				</div>
			</div>

			<!-- Step 3: Preferences -->
			<div class:hidden={step !== 3}>
				<div class="space-y-4">
					<h2 class="text-lg font-semibold">{t('setup.preferences')}</h2>
					<Select name="language" label={t('settings.interfaceLanguage')} value="en" options={interfaceLanguageOptions} />
					<Select name="currency" label={t('settings.defaultCurrency')} value="EUR" options={currencyOptions} />
					<Select name="dateFormat" label={t('settings.dateFormat')} value="DD/MM/YYYY" options={dateFormatOptions} />
					<div class="grid grid-cols-2 gap-4">
						<Input name="defaultTaxRate" type="number" label={t('label.defaultTaxRatePercent')} value="21" />
						<Input name="paymentTermDays" type="number" label={t('label.paymentTermsDays')} value="30" />
					</div>
				</div>
				<div class="mt-6 flex gap-3">
					<Btn type="button" variant="ghost" onclick={() => step = 2}>{t('action.back')}</Btn>
					<Btn type="submit" class="flex-1" {loading}>{t('setup.completeSetup')}</Btn>
				</div>
			</div>
		</form>
	</Card>
</div>
