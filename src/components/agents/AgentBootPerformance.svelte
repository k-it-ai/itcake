<script lang="ts">
	import Card from '#lib/components/ui/Card.svelte';
	import SectionHead from '#lib/components/ui/SectionHead.svelte';
	import Btn from '#lib/components/ui/Btn.svelte';
	import { toast } from '#components/ui/Toast.svelte';
	import { api, getErrorMessage } from '#lib/api.js';
	import { invalidateAll } from '$app/navigation';
	import { t } from '#lib/i18n/index.svelte.js';
	import type { BootPerformanceTrend } from '#services/boot-performance.js';

	let {
		agentId,
		trend,
		disabled = false
	}: {
		agentId: string;
		trend: BootPerformanceTrend;
		disabled?: boolean;
	} = $props();

	let busy = $state(false);

	async function collect() {
		busy = true;
		try {
			await api.post(`/api/agents/${agentId}/boot-performance`, { action: 'collect' });
			toast(t('agents.bootDispatched'), 'success');
			setTimeout(() => invalidateAll(), 1000);
		} catch (e) {
			toast(getErrorMessage(e, t('agents.dispatchFailed')), 'error');
		} finally {
			busy = false;
		}
	}

	function fmtSec(s: number | null | undefined): string {
		if (s == null || !Number.isFinite(s)) return '—';
		return `${s.toFixed(1)}s`;
	}

	function fmtTs(s: string): string {
		try { return new Date(s).toLocaleString('de-DE', { dateStyle: 'short', timeStyle: 'short' }); }
		catch { return s; }
	}

	function totalColor(s: number | null | undefined): string {
		if (s == null) return 'var(--muted)';
		if (s > 180) return 'var(--bad)';
		if (s > 90) return 'var(--warn)';
		return 'var(--good)';
	}

	// 14-day bar series — render as small bar chart per 05-pages.md spec.
	const barData = $derived.by(() => {
		const slice = (trend.history ?? []).slice(0, 14).reverse();
		const max = slice.reduce((m, b) => Math.max(m, b.totalBootSeconds || 0), 0) || 1;
		return slice.map(b => ({
			value: b.totalBootSeconds || 0,
			heightPct: ((b.totalBootSeconds || 0) / max) * 100,
			isSlow: (b.totalBootSeconds || 0) > 26
		}));
	});
</script>

<Card>
	<SectionHead title={t('agents.bootTitle')} sub={trend.history.length > 0 ? t('agents.bootLastN', { count: trend.history.length }) : undefined}>
		{#snippet right()}
			<Btn variant="soft" size="sm" onclick={collect} {disabled} title={busy ? t('agents.bootCollecting') : t('agents.bootCollectNow')}>
				{busy ? t('agents.bootCollecting') : t('agents.bootCollectNow')}
			</Btn>
		{/snippet}
	</SectionHead>

	{#if !trend.latest}
		<p class="text-[11.5px]" style="color:var(--muted)">{t('agents.bootEmpty')}</p>
	{:else}
		<div class="grid grid-cols-2 gap-3 sm:grid-cols-4 mb-4">
			<div>
				<div class="text-[11px]" style="color:var(--muted)">{t('dashboard.total')}</div>
				<div class="text-[15px] font-semibold num" style="color:{totalColor(trend.latest.totalBootSeconds)}">{fmtSec(trend.latest.totalBootSeconds)}</div>
			</div>
			<div>
				<div class="text-[11px]" style="color:var(--muted)">BIOS</div>
				<div class="text-[15px] font-semibold num" style="color:var(--ink)">{fmtSec(trend.latest.biosSeconds)}</div>
			</div>
			<div>
				<div class="text-[11px]" style="color:var(--muted)">{t('agents.bootOsLoader')}</div>
				<div class="text-[15px] font-semibold num" style="color:var(--ink)">{fmtSec(trend.latest.osLoaderSeconds)}</div>
			</div>
			<div>
				<div class="text-[11px]" style="color:var(--muted)">{t('agents.bootDesktopReady')}</div>
				<div class="text-[15px] font-semibold num" style="color:var(--ink)">{fmtSec(trend.latest.desktopReadySeconds)}</div>
			</div>
		</div>

		{#if barData.length > 0}
			<div class="mb-3">
				<div class="flex items-end gap-0.5" style="height:60px">
					{#each barData as b}
						<div
							class="flex-1 rounded-sm transition-colors"
							style="height:{Math.max(2, b.heightPct)}%;background:{b.isSlow ? 'var(--bad)' : 'var(--brand)'}"
							title={`${b.value.toFixed(1)}s`}
						></div>
					{/each}
				</div>
				<div class="mt-1 flex justify-between text-[10px]" style="color:var(--muted)">
					<span>−{barData.length}d</span>
					<span>{t('agents.bootNow')}</span>
				</div>
			</div>
		{/if}

		<div class="grid grid-cols-3 gap-3 text-[11px] pt-3 mb-3" style="border-top:1px solid var(--line-2)">
			<div>
				<div style="color:var(--muted)">{t('agents.bootMedian')}</div>
				<div class="text-[13px] font-mono num" style="color:var(--ink)">{fmtSec(trend.medianTotalSeconds)}</div>
			</div>
			<div>
				<div style="color:var(--muted)">P95</div>
				<div class="text-[13px] font-mono num" style="color:var(--ink)">{fmtSec(trend.p95TotalSeconds)}</div>
			</div>
			<div>
				<div style="color:var(--muted)">{t('agents.bootSlowCount')}</div>
				<div class="text-[13px] font-mono num" style="color:var(--ink)">{trend.slowBootCount}</div>
			</div>
		</div>

		{#if trend.latest.startupItemCount > 0}
			<div class="text-[11px]" style="color:var(--muted)">
				{t('agents.bootStartupSummary', { count: trend.latest.startupItemCount, source: trend.latest.source || '—' })}
			</div>
		{/if}

		{#if trend.history.length > 1}
			<details class="mt-3">
				<summary class="text-[11.5px] cursor-pointer transition-colors" style="color:var(--muted)">{t('agents.bootShowHistory', { count: trend.history.length })}</summary>
				<table class="w-full mt-2 text-[11px]">
					<thead>
						<tr style="border-bottom:1px solid var(--line-2)">
							<th class="text-left py-1 text-[10.5px] uppercase tracking-wide font-medium" style="color:var(--muted)">{t('agents.bootTime')}</th>
							<th class="text-right py-1 text-[10.5px] uppercase tracking-wide font-medium" style="color:var(--muted)">{t('dashboard.total')}</th>
							<th class="text-right py-1 text-[10.5px] uppercase tracking-wide font-medium" style="color:var(--muted)">BIOS</th>
							<th class="text-right py-1 text-[10.5px] uppercase tracking-wide font-medium" style="color:var(--muted)">{t('agents.bootLoader')}</th>
							<th class="text-right py-1 text-[10.5px] uppercase tracking-wide font-medium" style="color:var(--muted)">{t('agents.bootDesktop')}</th>
							<th class="text-right py-1 text-[10.5px] uppercase tracking-wide font-medium" style="color:var(--muted)">{t('agents.bootStartup')}</th>
						</tr>
					</thead>
					<tbody>
						{#each trend.history as boot (boot.bootTimestamp)}
							<tr style="border-bottom:1px solid var(--line-2)">
								<td class="py-1 num" style="color:var(--ink)">{fmtTs(boot.bootTimestamp)}</td>
								<td class="py-1 text-right num" style="color:{totalColor(boot.totalBootSeconds)}">{fmtSec(boot.totalBootSeconds)}</td>
								<td class="py-1 text-right num" style="color:var(--ink)">{fmtSec(boot.biosSeconds)}</td>
								<td class="py-1 text-right num" style="color:var(--ink)">{fmtSec(boot.osLoaderSeconds)}</td>
								<td class="py-1 text-right num" style="color:var(--ink)">{fmtSec(boot.desktopReadySeconds)}</td>
								<td class="py-1 text-right num" style="color:var(--ink)">{boot.startupItemCount}</td>
							</tr>
						{/each}
					</tbody>
				</table>
			</details>
		{/if}
	{/if}
</Card>
