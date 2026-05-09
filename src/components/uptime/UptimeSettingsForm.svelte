<script lang="ts">
	import { t } from '$lib/i18n/index.svelte.js';
	import Modal from '$components/ui/Modal.svelte';
	import Input from '$components/ui/Input.svelte';
	import Button from '$components/ui/Button.svelte';
	import Toggle from '$components/ui/Toggle.svelte';
	import { toast } from '$components/ui/Toast.svelte';

	interface Props {
		open: boolean;
		onclose: () => void;
	}

	let { open = $bindable(false), onclose }: Props = $props();

	let telegramEnabled = $state(false);
	let botToken = $state('');
	let chatId = $state('');
	let emailAlertsEnabled = $state(false);
	let alertEmail = $state('');
	let saving = $state(false);
	let testingTelegram = $state(false);

	$effect(() => {
		if (open) loadSettings();
	});

	async function loadSettings() {
		try {
			const res = await fetch('/api/uptime/settings');
			if (!res.ok) return;
			const data = await res.json();
			telegramEnabled = data?.telegram?.enabled ?? false;
			botToken = data?.telegram?.botToken ?? '';
			chatId = data?.telegram?.chatId ?? '';
			emailAlertsEnabled = data?.emailAlerts ?? false;
			alertEmail = data?.alertEmail ?? '';
		} catch { /* ignore */ }
	}

	async function save() {
		if (telegramEnabled) {
			if (!botToken || botToken === '••••••••') {
				toast(t('validation.telegramBotTokenRequired'), 'error');
				return;
			}
			if (!chatId) {
				toast(t('validation.telegramChatIdRequired'), 'error');
				return;
			}
		}
		if (emailAlertsEnabled && !alertEmail) {
			toast(t('validation.alertEmailRequired'), 'error');
			return;
		}

		saving = true;
		try {
			const res = await fetch('/api/uptime/settings', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({
					telegram: { botToken, chatId, enabled: telegramEnabled },
					emailAlerts: emailAlertsEnabled,
					alertEmail,
				})
			});
			if (res.ok) {
				toast(t('toast.uptimeSettingsSaved'));
				onclose();
			} else {
				const err = await res.json().catch(() => ({}));
				toast(err.message || t('toast.error'), 'error');
			}
		} catch {
			toast(t('toast.networkError'), 'error');
		}
		saving = false;
	}

	async function testTelegramConnection() {
		testingTelegram = true;
		try {
			const res = await fetch('/api/uptime/test-telegram', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ botToken, chatId })
			});
			const data = await res.json();
			if (data.success) {
				toast(t('uptime.telegramConnected', { name: data.botName ?? 'Bot' }));
			} else {
				toast(t('uptime.telegramFailed', { error: data.error ?? 'Unknown' }), 'error');
			}
		} catch {
			toast(t('toast.networkError'), 'error');
		}
		testingTelegram = false;
	}
</script>

<Modal {open} title={t('uptime.settings')} {onclose}>
	{#snippet children()}
		<div class="space-y-5">
			<!-- Telegram section -->
			<div class="space-y-3">
				<h3 class="text-sm font-semibold text-ink">{t('uptime.telegramAlerts')}</h3>
				<Toggle bind:checked={telegramEnabled} label={t('uptime.telegramEnabled')} />
				{#if telegramEnabled}
					<Input label={t('uptime.telegramBotToken')} bind:value={botToken} placeholder="123456:ABC-DEF..." />
					<Input label={t('uptime.telegramChatId')} bind:value={chatId} placeholder="-1001234567890" />
					<Button variant="secondary" size="sm" onclick={testTelegramConnection} loading={testingTelegram}>
						{t('uptime.testTelegram')}
					</Button>
				{/if}
			</div>

			<!-- Email section -->
			<div class="space-y-3">
				<h3 class="text-sm font-semibold text-ink">{t('uptime.emailAlerts')}</h3>
				<Toggle bind:checked={emailAlertsEnabled} label={t('uptime.emailAlertsEnabled')} />
				{#if emailAlertsEnabled}
					<Input label={t('uptime.alertEmail')} type="email" bind:value={alertEmail} placeholder={t('placeholder.adminEmail')} />
					<p class="text-xs text-ink/60">{t('uptime.emailAlertsHelp')}</p>
				{/if}
			</div>
		</div>
	{/snippet}
	{#snippet actions()}
		<Button variant="secondary" onclick={onclose}>{t('action.cancel')}</Button>
		<Button onclick={save} loading={saving}>{t('action.save')}</Button>
	{/snippet}
</Modal>
