<script lang="ts">
	import { onMount } from 'svelte';
	import Card from '#lib/components/ui/Card.svelte';
	import SectionHead from '#lib/components/ui/SectionHead.svelte';
	import Btn from '#lib/components/ui/Btn.svelte';
	import StatusPill from '#lib/components/ui/StatusPill.svelte';
	import Tag from '#lib/components/ui/Tag.svelte';
	import Input from '#components/ui/Input.svelte';
	import Toggle from '#components/ui/Toggle.svelte';
	import { toast } from '#components/ui/Toast.svelte';
	import { api, getErrorMessage } from '#lib/api.js';
	import { t } from '#lib/i18n/index.svelte.js';

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
	<Card padding={20}>
		<SectionHead title={t('rd.title')} sub={t('rd.help')}>
			{#snippet right()}
				<Toggle bind:checked={cfg.enabled} label={t('action.enabled')} />
			{/snippet}
		</SectionHead>

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
			<p class="text-[11.5px] mt-2" style="color:var(--muted)">{t('rd.reverseProxyHint')}</p>
		{/if}

		<div class="flex flex-wrap gap-2 pt-3">
			<Btn variant="primary" size="md" onclick={save} disabled={saving}>{saving ? '…' : t('action.save')}</Btn>
		</div>
	</Card>

	{#if cfg.enabled}
		<Card padding={20}>
			<SectionHead title={t('rd.guacdStatus')} />
			{#if status}
				<div class="grid grid-cols-3 gap-4 text-[12.5px]">
					<div>
						<div class="text-[11px]" style="color:var(--muted)">{t('rd.installed')}</div>
						<div class="mt-1">
							{#if status.installed}
								<StatusPill tone="good" action={false}>{status.version || t('rd.installed')}</StatusPill>
							{:else}
								<StatusPill tone="bad" action={false}>{t('rd.notInstalled')}</StatusPill>
							{/if}
						</div>
					</div>
					<div>
						<div class="text-[11px]" style="color:var(--muted)">{t('rd.reachable')}</div>
						<div class="mt-1">
							{#if status.reachable}
								<Tag tone="good">ok</Tag>
							{:else}
								<Tag tone="bad">{t('rd.unreachable')}</Tag>
							{/if}
						</div>
					</div>
					<div>
						<div class="text-[11px]" style="color:var(--muted)">{t('rd.endpoint')}</div>
						<div class="font-mono text-[11.5px] mt-1" style="color:var(--ink)">{status.host}:{status.port}</div>
					</div>
				</div>
			{/if}
			<div class="flex flex-wrap gap-2 mt-3">
				<Btn variant="ghost" size="md" onclick={install} disabled={installing}>{installing ? '…' : t('rd.installGuacd')}</Btn>
				<Btn variant="ghost" size="md" onclick={update} disabled={updating}>{updating ? '…' : t('rd.updateGuacd')}</Btn>
			</div>
			{#if cmdOutput}
				<details class="text-[11.5px] mt-2">
					<summary class="cursor-pointer" style="color:var(--muted)">{t('rd.commandOutput')} ({cmdOutput.manager || '?'})</summary>
					<pre class="mt-2 p-3 rounded-md overflow-auto max-h-64 whitespace-pre-wrap font-mono text-[11px]" style="background:#fbfcfd; border:1px solid var(--line-2); color:var(--ink)">{cmdOutput.stdout}{cmdOutput.stderr ? '\n--- stderr ---\n' + cmdOutput.stderr : ''}</pre>
				</details>
			{/if}
			<p class="text-[11.5px] mt-2" style="color:var(--muted)">{t('rd.installPermissions')}</p>
		</Card>
	{/if}
</div>
