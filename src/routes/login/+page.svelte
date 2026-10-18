<script lang="ts">
	import { enhance } from '$app/forms';
	import Btn from '#lib/components/ui/Btn.svelte';
	import Input from '#components/ui/Input.svelte';
	import Card from '#lib/components/ui/Card.svelte';
	import { theme } from '#lib/stores/theme.svelte.js';
	import { t } from '#lib/i18n/index.svelte.js';
	import type { ActionData } from './$types.js';

	let { form }: { form: ActionData } = $props();
	let loading = $state(false);
</script>

<div class="relative flex min-h-screen items-center justify-center bg-bg px-4">
	<button
		onclick={() => theme.toggle()}
		class="absolute top-4 right-4 rounded-lg p-2 text-ink/50 hover:text-ink hover:bg-card transition-colors"
		aria-label={t('aria.toggleTheme')}
	>
		{#if theme.value === 'dark'}
			<svg class="h-5 w-5" fill="none" stroke="currentColor" viewBox="0 0 24 24" stroke-width="1.5"><path stroke-linecap="round" stroke-linejoin="round" d="M12 3v2.25m6.364.386l-1.591 1.591M21 12h-2.25m-.386 6.364l-1.591-1.591M12 18.75V21m-4.773-4.227l-1.591 1.591M5.25 12H3m4.227-4.773L5.636 5.636M15.75 12a3.75 3.75 0 11-7.5 0 3.75 3.75 0 017.5 0z" /></svg>
		{:else}
			<svg class="h-5 w-5" fill="none" stroke="currentColor" viewBox="0 0 24 24" stroke-width="1.5"><path stroke-linecap="round" stroke-linejoin="round" d="M21.752 15.002A9.718 9.718 0 0118 15.75c-5.385 0-9.75-4.365-9.75-9.75 0-1.33.266-2.597.748-3.752A9.753 9.753 0 003 11.25C3 16.635 7.365 21 12.75 21a9.753 9.753 0 009.002-5.998z" /></svg>
		{/if}
	</button>
	<Card class="w-full max-w-md">
		<div class="text-center mb-8">
			<h1 class="text-2xl font-bold text-ink">{t('login.title')}</h1>
			<p class="mt-2 text-sm text-ink/60">{t('login.subtitle')}</p>
		</div>

		{#if form?.error}
			<div role="alert" class="mb-4 rounded-lg bg-bad/10 px-4 py-3 text-sm text-bad dark:text-bad-300">
				{form.error}
			</div>
		{/if}

		<form method="POST" use:enhance={() => {
			loading = true;
			return async ({ update }) => {
				loading = false;
				await update();
			};
		}}>
			{#if form?.mfaRequired}
				<!-- Step 2: MFA code. The mfaToken HMAC binds this submission to the
				     password proof from step 1. The server re-verifies the password
				     here, so the user re-enters email (hidden) + password + code in
				     one form. Do NOT add a hidden `password` field: a duplicate
				     shadows the visible input in FormData (get() returns the first
				     value) and rejects every login attempt. -->
				<div class="space-y-4">
					<input type="hidden" name="email" value={form.email ?? ''} />
					<input type="hidden" name="mfaToken" value={form.mfaToken ?? ''} />
					<p class="text-sm text-ink/70">{t('login.mfaTitle')}</p>
					<Input name="password" type="password" label={t('setup.password')} required placeholder={t('login.passwordPlaceholder')} autocomplete="current-password" />
					<Input name="mfaCode" label={t('login.mfaCode')} required autofocus autocomplete="one-time-code" />
				</div>

				<div class="mt-6">
					<Btn type="submit" class="w-full" {loading}>{t('login.mfaSubmit')}</Btn>
				</div>
			{:else}
				<div class="space-y-4">
					<Input name="email" type="email" label={t('label.email')} required value={form?.email ?? ''} placeholder={t('placeholder.emailExample')} autofocus autocomplete="username" />
					<Input name="password" type="password" label={t('setup.password')} required placeholder={t('login.passwordPlaceholder')} autocomplete="current-password" />
				</div>

				<div class="mt-6">
					<Btn type="submit" class="w-full" {loading}>{t('login.signIn')}</Btn>
				</div>
			{/if}
		</form>
	</Card>
</div>
