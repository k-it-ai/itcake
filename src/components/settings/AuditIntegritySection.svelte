<script lang="ts">
	/**
	 * Manual audit-log integrity check button. Single-click → walks the
	 * `changes.hash` chain and reports any tampered or unverified rows.
	 *
	 * Pre-migration rows have empty hash and show as `unverified` —
	 * harmless legacy state. Anything labeled `tampered` indicates real
	 * row insertion / deletion / mutation; treat as a security incident.
	 */
	import Card from '$components/ui/Card.svelte';
	import Button from '$components/ui/Button.svelte';
	import Badge from '$components/ui/Badge.svelte';
	import { toast } from '$components/ui/Toast.svelte';
	import { api, getErrorMessage } from '$lib/api.js';
	import { t } from '$lib/i18n/index.svelte.js';

	interface IntegrityResult {
		total: number;
		verified: number;
		unverified: number;
		tampered: number;
		tamperedIds: string[];
	}

	let result = $state<IntegrityResult | null>(null);
	let checking = $state(false);

	async function check() {
		checking = true;
		try {
			result = await api.get<IntegrityResult>('/api/changes/integrity');
			if (result.tampered > 0) toast(t('audit.tamperFound'), 'error');
			else toast(t('audit.noTamper'), 'success');
		} catch (e) {
			toast(getErrorMessage(e, t('toast.failedLoad')), 'error');
		} finally {
			checking = false;
		}
	}
</script>

<Card class="space-y-3">
	<div>
		<h3 class="text-lg font-semibold">{t('audit.title')}</h3>
		<p class="text-xs text-near-black/60 mt-1">{t('audit.help')}</p>
	</div>
	<div class="flex items-center gap-3">
		<Button onclick={check} loading={checking}>{t('audit.checkNow')}</Button>
		<a class="text-xs text-near-black/60 hover:text-cyan underline-offset-2 hover:underline" href="/api/exports?kind=audit" download>
			Export CSV
		</a>
	</div>
	{#if result}
		<div class="grid grid-cols-4 gap-3 pt-2">
			<div>
				<div class="text-xs text-near-black/60">{t('audit.total')}</div>
				<div class="text-2xl font-mono">{result.total}</div>
			</div>
			<div>
				<div class="text-xs text-near-black/60">{t('audit.verified')}</div>
				<div class="text-2xl font-mono text-green-700 dark:text-green-300">{result.verified}</div>
			</div>
			<div>
				<div class="text-xs text-near-black/60">{t('audit.unverified')}</div>
				<div class="text-2xl font-mono text-amber-700 dark:text-amber-300">{result.unverified}</div>
			</div>
			<div>
				<div class="text-xs text-near-black/60">{t('audit.tampered')}</div>
				<div class="text-2xl font-mono {result.tampered > 0 ? 'text-red-700 dark:text-red-400' : ''}">{result.tampered}</div>
			</div>
		</div>
		{#if result.tamperedIds.length > 0}
			<div class="rounded border border-red-500/40 bg-red-500/10 p-3 text-sm">
				<div class="font-medium mb-1">{t('audit.tamperedIds')}</div>
				<div class="font-mono text-xs">{result.tamperedIds.join(', ')}</div>
			</div>
		{/if}
	{/if}
</Card>
