<script lang="ts">
	import { t } from '$lib/i18n/index.svelte.js';
	import Modal from '$components/ui/Modal.svelte';
	import Input from '$components/ui/Input.svelte';
	import Button from '$components/ui/Button.svelte';
	import Toggle from '$components/ui/Toggle.svelte';
	import type { Monitor } from '$lib/types.js';

	interface Props {
		open: boolean;
		monitor?: Monitor | null;
		onclose: () => void;
		onsave: (data: MonitorFormData) => void;
	}

	export interface MonitorFormData {
		name: string;
		ip: string;
		domain: string;
		enabled: boolean;
		checks: { ping: boolean; http: boolean; domainExpiry: boolean; sslExpiry: boolean };
		httpExpectedStatus: number;
		domainExpiryThresholdDays: number;
		sslExpiryThresholdDays: number;
	}

	let { open = $bindable(false), monitor = null, onclose, onsave }: Props = $props();

	let name = $state('');
	let ip = $state('');
	let domain = $state('');
	let enabled = $state(true);
	let pingCheck = $state(true);
	let httpCheck = $state(true);
	let domainCheck = $state(false);
	let sslCheck = $state(false);
	let httpExpectedStatus = $state(200);
	let domainThreshold = $state(30);
	let sslThreshold = $state(14);
	let error = $state('');

	$effect(() => {
		if (open) {
			if (monitor) {
				name = monitor.name;
				ip = monitor.ip;
				domain = monitor.domain;
				enabled = monitor.enabled;
				pingCheck = monitor.checks.ping;
				httpCheck = monitor.checks.http;
				domainCheck = monitor.checks.domainExpiry;
				sslCheck = monitor.checks.sslExpiry;
				httpExpectedStatus = monitor.httpExpectedStatus;
				domainThreshold = monitor.domainExpiryThresholdDays;
				sslThreshold = monitor.sslExpiryThresholdDays;
			} else {
				name = '';
				ip = '';
				domain = '';
				enabled = true;
				pingCheck = true;
				httpCheck = true;
				domainCheck = false;
				sslCheck = false;
				httpExpectedStatus = 200;
				domainThreshold = 30;
				sslThreshold = 14;
			}
			error = '';
		}
	});

	const ipRegex = /^(\d{1,3}\.){3}\d{1,3}$|^[0-9a-fA-F:]+$/;
	const domainRegex = /^[a-zA-Z0-9.\-]+$/;

	let showIp = $derived(pingCheck);
	let showDomain = $derived(httpCheck || domainCheck || sslCheck);

	let ipError = $derived.by(() => {
		const v = ip.trim();
		if (!v) return '';
		return ipRegex.test(v) ? '' : t('uptime.ipInvalid');
	});
	let domainError = $derived.by(() => {
		const v = domain.trim();
		if (!v) return '';
		if (!domainRegex.test(v) || !v.includes('.') || /^(\d{1,3}\.){3}\d{1,3}$/.test(v)) return t('uptime.domainInvalid');
		return '';
	});

	function handleSave() {
		const trimIp = ip.trim();
		const trimDomain = domain.trim();
		if (!name.trim()) { error = t('validation.required'); return; }
		if (!pingCheck && !httpCheck && !domainCheck && !sslCheck) {
			error = t('uptime.atLeastOneCheck');
			return;
		}
		if (!trimIp && !trimDomain) { error = t('uptime.ipOrDomainRequired'); return; }
		if (trimIp && !ipRegex.test(trimIp)) { error = t('uptime.ipInvalid'); return; }
		if (trimDomain && (!domainRegex.test(trimDomain) || !trimDomain.includes('.') || /^(\d{1,3}\.){3}\d{1,3}$/.test(trimDomain))) { error = t('uptime.domainInvalid'); return; }
		if ((domainCheck || sslCheck) && !trimDomain) { error = t('uptime.domainRequiredForExpiry'); return; }
		onsave({
			name: name.trim(),
			ip: trimIp,
			domain: trimDomain,
			enabled,
			checks: { ping: pingCheck, http: httpCheck, domainExpiry: domainCheck, sslExpiry: sslCheck },
			httpExpectedStatus,
			domainExpiryThresholdDays: domainThreshold,
			sslExpiryThresholdDays: sslThreshold,
		});
	}
</script>

<Modal {open} title={monitor ? t('action.edit') : t('uptime.new')} {onclose}>
	{#snippet children()}
		<div class="space-y-4">
			{#if error}
				<p class="text-sm text-bad dark:text-bad-300">{error}</p>
			{/if}

			<Input label={t('uptime.monitorName')} bind:value={name} placeholder={t('placeholder.monitorName')} required />

			<div>
				<span class="block text-sm font-medium text-ink mb-2">{t('uptime.checkTypes')}</span>
				<div class="grid grid-cols-2 gap-2">
					<Toggle bind:checked={pingCheck} label={t('uptime.checkPing')} />
					<Toggle bind:checked={httpCheck} label={t('uptime.checkHttp')} />
					<Toggle bind:checked={domainCheck} label={t('uptime.checkDomainExpiry')} />
					<Toggle bind:checked={sslCheck} label={t('uptime.checkSslExpiry')} />
				</div>
			</div>

			{#if showIp}
				<div>
					<Input label={t('uptime.ip')} bind:value={ip} placeholder={t('uptime.ipPlaceholder')} />
					{#if ipError}<p class="text-xs text-bad dark:text-bad-300 mt-1">{ipError}</p>{/if}
				</div>
			{/if}

			{#if showDomain}
				<div>
					<Input label={t('uptime.domain')} bind:value={domain} placeholder={t('uptime.domainPlaceholder')} />
					{#if domainError}<p class="text-xs text-bad dark:text-bad-300 mt-1">{domainError}</p>{/if}
				</div>
			{/if}

			{#if httpCheck}
				<Input label={t('uptime.httpExpectedStatus')} type="number" bind:value={httpExpectedStatus} />
			{/if}

			{#if domainCheck}
				<Input label={t('uptime.domainExpiryThreshold')} type="number" bind:value={domainThreshold} />
			{/if}

			{#if sslCheck}
				<Input label={t('uptime.sslExpiryThreshold')} type="number" bind:value={sslThreshold} />
			{/if}

			<Toggle bind:checked={enabled} label={t('uptime.enabled')} />
		</div>
	{/snippet}
	{#snippet actions()}
		<Button variant="secondary" onclick={onclose}>{t('action.cancel')}</Button>
		<Button onclick={handleSave}>{monitor ? t('action.save') : t('action.create')}</Button>
	{/snippet}
</Modal>
