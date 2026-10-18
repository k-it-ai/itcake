<script lang="ts">
	import { onMount } from 'svelte';
	import Card from '#lib/components/ui/Card.svelte';
	import SectionHead from '#lib/components/ui/SectionHead.svelte';
	import Btn from '#lib/components/ui/Btn.svelte';
	import Input from '#components/ui/Input.svelte';
	import { toast } from '#components/ui/Toast.svelte';
	import { api, getErrorMessage } from '#lib/api.js';
	import { t } from '#lib/i18n/index.svelte.js';

	interface BackupCfg {
		encryptionPassphrase: string;
	}

	let cfg: BackupCfg = $state({ encryptionPassphrase: '' });
	let saving = $state(false);

	async function load() {
		try {
			const all = await api.get<{ backup?: BackupCfg }>('/api/settings');
			if (all.backup) cfg = { ...cfg, ...all.backup };
		} catch (e) {
			toast(getErrorMessage(e, t('toast.failedLoad')), 'error');
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
</script>

<div class="space-y-4">
	<Card padding={20}>
		<SectionHead title={t('backup.encryptionTitle')} sub={t('backup.encryptionHelp')} />
		<Input
			type="password"
			label={t('backup.passphrase')}
			placeholder={cfg.encryptionPassphrase === '***' ? t('backup.passphraseSet') : t('backup.passphraseEmpty')}
			bind:value={cfg.encryptionPassphrase}
		/>
		<p class="text-[11.5px] mt-2" style="color:var(--muted)">{t('backup.passphraseWarning')}</p>
		<div class="flex flex-wrap gap-2 pt-3">
			<Btn variant="primary" size="md" onclick={save} disabled={saving}>{saving ? '…' : t('action.save')}</Btn>
		</div>
	</Card>
</div>
