<script lang="ts">
	import { onMount } from 'svelte';
	import { t } from '$lib/i18n/index.svelte.js';
	import { api } from '$lib/api.js';
	import Card from '$components/ui/Card.svelte';
	import Button from '$components/ui/Button.svelte';
	import Input from '$components/ui/Input.svelte';
	import Modal from '$components/ui/Modal.svelte';
	import { toast } from '$components/ui/Toast.svelte';

	type Status = { enabled: boolean; recoveryCodesRemaining: number };
	type InitResult = { secret: string; uri: string; qrDataUrl: string; recoveryCodes: string[] };

	let status = $state<Status | null>(null);
	let loading = $state(false);

	let enrollOpen = $state(false);
	let enrollPassword = $state('');
	let enrollData = $state<InitResult | null>(null);
	let enrollCode = $state('');
	let enrollError = $state('');

	let disableOpen = $state(false);
	let disablePassword = $state('');
	let disableCode = $state('');
	let disableError = $state('');

	async function load() {
		const res = await fetch('/api/auth/mfa');
		if (res.ok) status = await res.json();
	}
	onMount(load);

	async function startEnroll() {
		enrollError = '';
		enrollData = null;
		loading = true;
		try {
			const r = await fetch('/api/auth/mfa', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ action: 'init', currentPassword: enrollPassword })
			});
			if (!r.ok) {
				enrollError = await r.text();
				return;
			}
			enrollData = await r.json();
		} finally {
			loading = false;
		}
	}

	// must not be bypassable by a session captured before the toggle).
	async function confirmEnroll() {
		if (!enrollData) return;
		enrollError = '';
		loading = true;
		try {
			const res = await api.post<{ ok: boolean; sessionRevoked?: boolean }>('/api/auth/mfa', {
				action: 'enable',
				secret: enrollData.secret,
				code: enrollCode,
				recoveryCodes: enrollData.recoveryCodes
			});
			toast(t('settings.mfaEnabled'), 'success');
			enrollOpen = false;
			enrollPassword = '';
			enrollCode = '';
			enrollData = null;
			if (res?.sessionRevoked) {
				window.location.assign('/login');
				return;
			}
			await load();
		} catch (e) {
			enrollError = e instanceof Error ? e.message : String(e);
		} finally {
			loading = false;
		}
	}

	async function confirmDisable() {
		disableError = '';
		loading = true;
		try {
			const res = await api.post<{ ok: boolean; sessionRevoked?: boolean }>('/api/auth/mfa', {
				action: 'disable',
				currentPassword: disablePassword,
				code: disableCode
			});
			toast(t('settings.mfaDisabled'), 'success');
			disableOpen = false;
			disablePassword = '';
			disableCode = '';
			if (res?.sessionRevoked) {
				window.location.assign('/login');
				return;
			}
			await load();
		} catch (e) {
			disableError = e instanceof Error ? e.message : String(e);
		} finally {
			loading = false;
		}
	}

	function openEnroll() {
		enrollOpen = true;
		enrollData = null;
		enrollPassword = '';
		enrollCode = '';
		enrollError = '';
	}
</script>

<Card class="space-y-4">
	<div class="flex items-start justify-between gap-4">
		<div>
			<h3 class="text-lg font-semibold">{t('settings.mfa')}</h3>
			<p class="text-xs text-near-black/60 mt-1">{t('settings.mfaHelp')}</p>
		</div>
		{#if status}
			{#if status.enabled}
				<span class="text-sm font-medium text-green-700 dark:text-green-300">{t('settings.mfaEnabled')}</span>
			{:else}
				<span class="text-sm text-near-black/60">{t('settings.mfaDisabled')}</span>
			{/if}
		{/if}
	</div>

	{#if status?.enabled}
		<div class="text-sm text-near-black/70">
			{t('settings.mfaRecoveryRemaining')}: <span class="font-mono">{status.recoveryCodesRemaining}</span>
		</div>
		<Button variant="secondary" onclick={() => { disableOpen = true; disablePassword = ''; disableCode = ''; disableError = ''; }}>
			{t('settings.mfaDisable')}
		</Button>
	{:else if status}
		<Button onclick={openEnroll}>{t('settings.mfaEnable')}</Button>
	{/if}
</Card>

<Modal bind:open={enrollOpen} onclose={() => { enrollOpen = false; }} title={t('settings.mfaEnable')}>
	{#if !enrollData}
		<div class="space-y-3">
			<p class="text-sm text-near-black/70">{t('settings.mfaEnterPasswordToBegin')}</p>
			<Input type="password" label={t('settings.currentPassword')} bind:value={enrollPassword} />
			{#if enrollError}<p class="text-sm text-red">{enrollError}</p>{/if}
			<Button onclick={startEnroll} {loading} disabled={!enrollPassword}>{t('action.continue')}</Button>
		</div>
	{:else}
		<div class="space-y-4">
			<p class="text-sm">{t('settings.mfaScanQr')}</p>
			<div class="flex justify-center bg-white p-4 rounded">
				<img src={enrollData.qrDataUrl} alt="MFA QR" class="w-48 h-48" />
			</div>
			<details class="text-xs text-near-black/70">
				<summary class="cursor-pointer">{t('settings.mfaManualEntry')}</summary>
				<code class="block mt-2 break-all bg-bg-card border border-border rounded p-2 font-mono">{enrollData.secret}</code>
			</details>

			<div class="rounded border border-amber-500/30 bg-amber-500/10 p-3 text-sm">
				<p class="font-medium mb-2">{t('settings.mfaRecoveryCodesHeader')}</p>
				<p class="text-xs text-near-black/70 mb-2">{t('settings.mfaRecoveryCodesHelp')}</p>
				<div class="grid grid-cols-2 gap-1 font-mono text-xs">
					{#each enrollData.recoveryCodes as code (code)}
						<code class="bg-bg-card border border-border rounded px-2 py-1">{code}</code>
					{/each}
				</div>
			</div>

			<Input label={t('settings.mfaEnterCode')} bind:value={enrollCode} placeholder="123456" />
			{#if enrollError}<p class="text-sm text-red">{enrollError}</p>{/if}
			<Button onclick={confirmEnroll} {loading} disabled={!/^\d{6}$/.test(enrollCode)}>
				{t('settings.mfaEnable')}
			</Button>
		</div>
	{/if}
</Modal>

<Modal bind:open={disableOpen} onclose={() => { disableOpen = false; }} title={t('settings.mfaDisable')}>
	<div class="space-y-3">
		<p class="text-sm text-near-black/70">{t('settings.mfaDisableHelp')}</p>
		<Input type="password" label={t('settings.currentPassword')} bind:value={disablePassword} />
		<Input label={t('settings.mfaCodeOrRecovery')} bind:value={disableCode} />
		{#if disableError}<p class="text-sm text-red">{disableError}</p>{/if}
		<Button onclick={confirmDisable} {loading} disabled={!disablePassword || !disableCode}>
			{t('settings.mfaDisable')}
		</Button>
	</div>
</Modal>
