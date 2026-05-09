<script lang="ts">
	/**
	 * Manual audit-log integrity check button. Single-click → walks the
	 * `changes.hash` chain and reports any tampered or unverified rows.
	 *
	 * Pre-migration rows have empty hash and show as `unverified` —
	 * harmless legacy state. Anything labeled `tampered` indicates real
	 * row insertion / deletion / mutation; treat as a security incident.
	 */
	import Card from '$lib/components/ui/Card.svelte';
	import SectionHead from '$lib/components/ui/SectionHead.svelte';
	import Btn from '$lib/components/ui/Btn.svelte';
	import Tag from '$lib/components/ui/Tag.svelte';
	import { Download } from '$lib/icons';
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

<Card padding={20}>
	<SectionHead title={t('audit.title')} sub={t('audit.help')} />
	<div class="flex items-center gap-2 mb-3">
		<Btn variant="primary" size="md" onclick={check} disabled={checking}>
			{checking ? '…' : t('audit.checkNow')}
		</Btn>
		<Btn variant="ghost" size="md" href="/api/exports?kind=audit">
			{#snippet icon()}<Download size={14} strokeWidth={1.6} />{/snippet}
			{t('action.exportCsv')}
		</Btn>
	</div>
	{#if result}
		<div class="grid grid-cols-4 gap-3 pt-1">
			<div>
				<div class="text-[11px]" style="color:var(--muted)">{t('audit.total')}</div>
				<div class="text-[22px] font-semibold num" style="color:var(--ink)">{result.total}</div>
			</div>
			<div>
				<div class="text-[11px]" style="color:var(--muted)">{t('audit.verified')}</div>
				<div class="text-[22px] font-semibold num" style="color:var(--good)">{result.verified}</div>
			</div>
			<div>
				<div class="text-[11px]" style="color:var(--muted)">{t('audit.unverified')}</div>
				<div class="text-[22px] font-semibold num" style="color:var(--warn)">{result.unverified}</div>
			</div>
			<div>
				<div class="text-[11px]" style="color:var(--muted)">{t('audit.tampered')}</div>
				<div class="text-[22px] font-semibold num" style={result.tampered > 0 ? 'color:var(--bad)' : 'color:var(--ink)'}>{result.tampered}</div>
			</div>
		</div>
		{#if result.tamperedIds.length > 0}
			<div class="mt-3 rounded-md p-3 text-[12.5px]" style="background:var(--bad-soft); color:#7a1a22">
				<div class="font-medium mb-1 flex items-center gap-2">
					<Tag tone="bad">tampered</Tag>
					{t('audit.tamperedIds')}
				</div>
				<div class="font-mono text-[11.5px]">{result.tamperedIds.join(', ')}</div>
			</div>
		{/if}
	{/if}
</Card>
