<script lang="ts">
	import { onMount } from 'svelte';
	import Card from '$components/ui/Card.svelte';
	import Input from '$components/ui/Input.svelte';
	import Button from '$components/ui/Button.svelte';
	import Toggle from '$components/ui/Toggle.svelte';
	import Badge from '$components/ui/Badge.svelte';
	import { toast } from '$components/ui/Toast.svelte';
	import { api, getErrorMessage } from '$lib/api.js';
	import { t } from '$lib/i18n/index.svelte.js';

	interface RDCfg {
		enabled: boolean;
		guacdHost: string;
		guacdPort: number;
		proxyPort: number;
		recordingEnabled: boolean;
		maxSessionMinutes: number;
		tokenTtlSeconds: number;
	}
	interface GuacStatus {
		installed: boolean;
		version: string | null;
		reachable: boolean;
		host: string;
		port: number;
	}

	let cfg: RDCfg = $state({
		enabled: false, guacdHost: '127.0.0.1', guacdPort: 4822,
		proxyPort: 4823, recordingEnabled: false,
		maxSessionMinutes: 60, tokenTtlSeconds: 300
	});
	let status = $state<GuacStatus | null>(null);
	let saving = $state(false);
	let installing = $state(false);
	let updating = $state(false);
	type CmdOutput = { ok: boolean; stdout: string; stderr: string; manager: string | null };
	let cmdOutput = $state<CmdOutput | null>(null);

	async function loadAll() {
		try {
			const all = await api.get<{ remoteDesktop?: RDCfg }>('/api/settings');
			if (all.remoteDesktop) cfg = { ...cfg, ...all.remoteDesktop };
			status = await api.get<GuacStatus>('/api/remote-desktop/guacd');
		} catch (e) {
			toast(getErrorMessage(e, t('toast.failedLoad')), 'error');
		}
	}
	onMount(loadAll);

	async function save() {
		saving = true;
		try {
			await api.post('/api/settings', { section: 'remoteDesktop', data: cfg });
			toast(t('toast.settingsSaved'), 'success');
			await loadAll();
		} catch (e) {
			toast(getErrorMessage(e, t('toast.failedSave')), 'error');
		} finally {
			saving = false;
		}
	}

	async function install() {
		installing = true;
		cmdOutput = null;
		try {
			const r = await api.post<CmdOutput>('/api/remote-desktop/guacd', { action: 'install' });
			cmdOutput = r;
			if (r.ok) toast(t('rd.installOk'), 'success');
			else toast(t('rd.installFailed'), 'error');
			await loadAll();
		} catch (e) {
			toast(getErrorMessage(e, t('rd.installFailed')), 'error');
		} finally {
			installing = false;
		}
	}

	async function update() {
		updating = true;
		cmdOutput = null;
		try {
			const r = await api.post<CmdOutput>('/api/remote-desktop/guacd', { action: 'update' });
			cmdOutput = r;
			if (r.ok) toast(t('rd.updateOk'), 'success');
			else toast(t('rd.updateFailed'), 'error');
			await loadAll();
		} catch (e) {
			toast(getErrorMessage(e, t('rd.updateFailed')), 'error');
		} finally {
			updating = false;
		}
	}
</script>

<div class="space-y-4">
	<Card class="space-y-4">
		<div class="flex items-start justify-between gap-4">
			<div>
				<h3 class="text-lg font-semibold">{t('rd.title')}</h3>
				<p class="text-xs text-near-black/60 mt-1">{t('rd.help')}</p>
			</div>
			<Toggle bind:checked={cfg.enabled} label={t('action.enabled')} />
		</div>

		{#if cfg.enabled}
			<div class="grid sm:grid-cols-2 gap-4">
				<Input label={t('rd.guacdHost')} bind:value={cfg.guacdHost} />
				<Input type="number" label={t('rd.guacdPort')} bind:value={cfg.guacdPort} />
				<Input type="number" label={t('rd.proxyPort')} bind:value={cfg.proxyPort} />
				<Input type="number" label={t('rd.maxSessionMinutes')} bind:value={cfg.maxSessionMinutes} />
				<Input type="number" label={t('rd.tokenTtlSeconds')} bind:value={cfg.tokenTtlSeconds} />
				<div class="flex items-center pt-6">
					<Toggle bind:checked={cfg.recordingEnabled} label={t('rd.recordingEnabled')} />
				</div>
			</div>
			<p class="text-xs text-near-black/60">{t('rd.reverseProxyHint')}</p>
		{/if}

		<div class="flex flex-wrap gap-2 pt-2">
			<Button onclick={save} loading={saving}>{t('action.save')}</Button>
		</div>
	</Card>

	{#if cfg.enabled}
		<Card class="space-y-3">
			<h4 class="font-semibold">{t('rd.guacdStatus')}</h4>
			{#if status}
				<div class="grid grid-cols-3 gap-4 text-sm">
					<div>
						<div class="text-xs text-near-black/60">{t('rd.installed')}</div>
						<div>
							{#if status.installed}
								<Badge variant="success">{status.version || '✓'}</Badge>
							{:else}
								<Badge variant="danger">{t('rd.notInstalled')}</Badge>
							{/if}
						</div>
					</div>
					<div>
						<div class="text-xs text-near-black/60">{t('rd.reachable')}</div>
						<div>
							{#if status.reachable}
								<Badge variant="success">✓</Badge>
							{:else}
								<Badge variant="danger">✗</Badge>
							{/if}
						</div>
					</div>
					<div>
						<div class="text-xs text-near-black/60">{t('rd.endpoint')}</div>
						<div class="font-mono text-xs">{status.host}:{status.port}</div>
					</div>
				</div>
			{/if}
			<div class="flex flex-wrap gap-2">
				<Button variant="secondary" onclick={install} loading={installing}>{t('rd.installGuacd')}</Button>
				<Button variant="secondary" onclick={update} loading={updating}>{t('rd.updateGuacd')}</Button>
			</div>
			{#if cmdOutput}
				<details class="text-xs">
					<summary class="cursor-pointer">{t('rd.commandOutput')} ({cmdOutput.manager || '?'})</summary>
					<pre class="mt-2 p-3 bg-bg-card border border-border rounded overflow-auto max-h-64 whitespace-pre-wrap">{cmdOutput.stdout}{cmdOutput.stderr ? '\n--- stderr ---\n' + cmdOutput.stderr : ''}</pre>
				</details>
			{/if}
			<p class="text-xs text-near-black/60">{t('rd.installPermissions')}</p>
		</Card>
	{/if}
</div>
