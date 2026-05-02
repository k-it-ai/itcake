<script lang="ts">
	import { onMount } from 'svelte';
	import Card from '$components/ui/Card.svelte';
	import Input from '$components/ui/Input.svelte';
	import Select from '$components/ui/Select.svelte';
	import Button from '$components/ui/Button.svelte';
	import Toggle from '$components/ui/Toggle.svelte';
	import { toast } from '$components/ui/Toast.svelte';
	import { api, getErrorMessage } from '$lib/api.js';
	import { t } from '$lib/i18n/index.svelte.js';

	interface BackupCfg {
		encryptionPassphrase: string;
		offsite: {
			enabled: boolean;
			schedule: 'daily' | 'weekly' | 'manual';
			target: 's3' | 'webdav';
			s3: { endpoint: string; region: string; bucket: string; accessKeyId: string; secretAccessKey: string; pathPrefix: string };
			webdav: { url: string; username: string; password: string };
			retentionDays: number;
			lastUpload: { at: string; ok: boolean; error?: string; sizeBytes?: number } | null;
		};
	}

	let cfg: BackupCfg = $state({
		encryptionPassphrase: '',
		offsite: {
			enabled: false, schedule: 'daily', target: 's3',
			s3: { endpoint: '', region: 'us-east-1', bucket: '', accessKeyId: '', secretAccessKey: '', pathPrefix: 'itcake/' },
			webdav: { url: '', username: '', password: '' },
			retentionDays: 30, lastUpload: null
		}
	});
	let loading = $state(false);
	let saving = $state(false);
	let testing = $state(false);
	let runningNow = $state(false);

	async function load() {
		loading = true;
		try {
			const all = await api.get<{ backup?: BackupCfg }>('/api/settings');
			if (all.backup) cfg = { ...cfg, ...all.backup, offsite: { ...cfg.offsite, ...all.backup.offsite } };
		} catch (e) {
			toast(getErrorMessage(e, t('toast.failedLoad')), 'error');
		} finally {
			loading = false;
		}
	}
	onMount(load);

	async function save() {
		saving = true;
		try {
			await api.post('/api/settings', { section: 'backup', data: cfg });
			toast(t('toast.settingsSaved'), 'success');
			await load();
		} catch (e) {
			toast(getErrorMessage(e, t('toast.failedSave')), 'error');
		} finally {
			saving = false;
		}
	}

	async function testConnection() {
		testing = true;
		try {
			const r = await api.post<{ ok: boolean; error?: string; sizeBytes?: number }>('/api/backups/offsite', { test: true });
			if (r.ok) toast(t('backup.connectionOk'), 'success');
			else toast(r.error || t('backup.connectionFailed'), 'error');
		} catch (e) {
			toast(getErrorMessage(e, t('backup.connectionFailed')), 'error');
		} finally {
			testing = false;
		}
	}

	async function runNow() {
		runningNow = true;
		try {
			const r = await api.post<{ ok: boolean; error?: string; sizeBytes?: number; remoteKey?: string }>('/api/backups/offsite', { run: true });
			if (r.ok) toast(t('backup.uploadOk'), 'success');
			else toast(r.error || t('backup.uploadFailed'), 'error');
			await load();
		} catch (e) {
			toast(getErrorMessage(e, t('backup.uploadFailed')), 'error');
		} finally {
			runningNow = false;
		}
	}

	const scheduleOptions = [
		{ value: 'daily', label: t('backup.scheduleDaily') },
		{ value: 'weekly', label: t('backup.scheduleWeekly') },
		{ value: 'manual', label: t('backup.scheduleManual') }
	];
	const targetOptions = [
		{ value: 's3', label: 'S3-compatible (AWS / Backblaze B2 / R2 / MinIO)' },
		{ value: 'webdav', label: 'WebDAV (Nextcloud / Hetzner Storage Box / mod_dav)' }
	];

	function formatSize(bytes: number | undefined): string {
		if (!bytes) return '—';
		if (bytes < 1e6) return `${(bytes / 1e3).toFixed(0)} KB`;
		return `${(bytes / 1e6).toFixed(1)} MB`;
	}
</script>

<div class="space-y-4">
	<Card class="space-y-4">
		<div>
			<h3 class="text-lg font-semibold">{t('backup.encryptionTitle')}</h3>
			<p class="text-xs text-near-black/60 mt-1">{t('backup.encryptionHelp')}</p>
		</div>
		<Input
			type="password"
			label={t('backup.passphrase')}
			placeholder={cfg.encryptionPassphrase === '***' ? t('backup.passphraseSet') : t('backup.passphraseEmpty')}
			bind:value={cfg.encryptionPassphrase}
		/>
		<p class="text-xs text-near-black/60">{t('backup.passphraseWarning')}</p>
	</Card>

	<Card class="space-y-4">
		<div class="flex items-center justify-between">
			<div>
				<h3 class="text-lg font-semibold">{t('backup.offsiteTitle')}</h3>
				<p class="text-xs text-near-black/60 mt-1">{t('backup.offsiteHelp')}</p>
			</div>
			<Toggle bind:checked={cfg.offsite.enabled} label={t('action.enabled')} />
		</div>

		{#if cfg.offsite.enabled}
			<div class="grid sm:grid-cols-2 gap-4">
				<Select label={t('backup.target')} bind:value={cfg.offsite.target} options={targetOptions} />
				<Select label={t('backup.schedule')} bind:value={cfg.offsite.schedule} options={scheduleOptions} />
				<Input type="number" label={t('backup.retentionDays')} bind:value={cfg.offsite.retentionDays} />
			</div>

			{#if cfg.offsite.target === 's3'}
				<div class="grid sm:grid-cols-2 gap-4 pt-2 border-t border-border">
					<Input label={t('backup.s3Endpoint')} placeholder="https://s3.eu-central-003.backblazeb2.com" bind:value={cfg.offsite.s3.endpoint} />
					<Input label={t('backup.s3Region')} bind:value={cfg.offsite.s3.region} />
					<Input label={t('backup.s3Bucket')} bind:value={cfg.offsite.s3.bucket} />
					<Input label={t('backup.s3PathPrefix')} bind:value={cfg.offsite.s3.pathPrefix} />
					<Input label={t('backup.s3AccessKey')} bind:value={cfg.offsite.s3.accessKeyId} />
					<Input type="password" label={t('backup.s3SecretKey')} placeholder={cfg.offsite.s3.secretAccessKey === '***' ? t('backup.secretSet') : ''} bind:value={cfg.offsite.s3.secretAccessKey} />
				</div>
			{:else}
				<div class="grid sm:grid-cols-2 gap-4 pt-2 border-t border-border">
					<Input label={t('backup.webdavUrl')} placeholder="https://nextcloud.example.org/dav/itcake/" bind:value={cfg.offsite.webdav.url} />
					<Input label={t('backup.webdavUsername')} bind:value={cfg.offsite.webdav.username} />
					<Input type="password" label={t('backup.webdavPassword')} placeholder={cfg.offsite.webdav.password === '***' ? t('backup.secretSet') : ''} bind:value={cfg.offsite.webdav.password} />
				</div>
			{/if}

			{#if cfg.offsite.lastUpload}
				<div class="text-xs rounded border border-border bg-bg-card p-3 space-y-1">
					<div class="font-medium">{t('backup.lastUpload')}</div>
					<div class="font-mono text-near-black/70">
						{cfg.offsite.lastUpload.at} · {cfg.offsite.lastUpload.ok ? '✓ ' + formatSize(cfg.offsite.lastUpload.sizeBytes) : '✗ ' + (cfg.offsite.lastUpload.error || 'failed')}
					</div>
				</div>
			{/if}
		{/if}

		<div class="flex flex-wrap gap-2 pt-2">
			<Button onclick={save} loading={saving}>{t('action.save')}</Button>
			{#if cfg.offsite.enabled}
				<Button variant="secondary" onclick={testConnection} loading={testing}>{t('backup.testConnection')}</Button>
				<Button variant="secondary" onclick={runNow} loading={runningNow}>{t('backup.uploadNow')}</Button>
			{/if}
		</div>
	</Card>
</div>
