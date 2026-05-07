<script lang="ts">
	import Card from '$components/ui/Card.svelte';
	import Button from '$components/ui/Button.svelte';
	import { toast } from '$components/ui/Toast.svelte';
	import { api, getErrorMessage } from '$lib/api.js';
	import { invalidateAll } from '$app/navigation';
	import type { BootPerformanceTrend } from '$services/boot-performance.js';

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
			toast('Boot performance collection dispatched', 'success');
			setTimeout(() => invalidateAll(), 1000);
		} catch (e) {
			toast(getErrorMessage(e, 'Failed to dispatch'), 'error');
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
		if (s == null) return 'text-near-black/60';
		if (s > 180) return 'text-red-700 dark:text-red-300';
		if (s > 90) return 'text-amber-700 dark:text-amber-300';
		return 'text-emerald-700 dark:text-emerald-300';
	}
</script>

<Card>
	<div class="flex items-baseline justify-between mb-3">
		<h3 class="text-sm font-semibold text-near-black">Boot performance</h3>
		<Button size="sm" variant="secondary" onclick={collect} loading={busy} {disabled}>Collect now</Button>
	</div>

	{#if !trend.latest}
		<p class="text-xs text-near-black/60">No boot data yet — click Collect now after the agent reports a recent boot.</p>
	{:else}
		<div class="grid grid-cols-2 gap-3 sm:grid-cols-4 mb-4">
			<div>
				<div class="text-xs text-near-black/60">Total</div>
				<div class="text-xl font-semibold tabular-nums {totalColor(trend.latest.totalBootSeconds)}">{fmtSec(trend.latest.totalBootSeconds)}</div>
			</div>
			<div>
				<div class="text-xs text-near-black/60">BIOS</div>
				<div class="text-xl font-semibold tabular-nums">{fmtSec(trend.latest.biosSeconds)}</div>
			</div>
			<div>
				<div class="text-xs text-near-black/60">OS loader</div>
				<div class="text-xl font-semibold tabular-nums">{fmtSec(trend.latest.osLoaderSeconds)}</div>
			</div>
			<div>
				<div class="text-xs text-near-black/60">Desktop ready</div>
				<div class="text-xl font-semibold tabular-nums">{fmtSec(trend.latest.desktopReadySeconds)}</div>
			</div>
		</div>

		<div class="grid grid-cols-3 gap-3 text-xs border-t border-border pt-3 mb-3">
			<div>
				<div class="text-near-black/60">Median (last {trend.history.length})</div>
				<div class="text-base font-mono tabular-nums">{fmtSec(trend.medianTotalSeconds)}</div>
			</div>
			<div>
				<div class="text-near-black/60">P95</div>
				<div class="text-base font-mono tabular-nums">{fmtSec(trend.p95TotalSeconds)}</div>
			</div>
			<div>
				<div class="text-near-black/60">Slow boots (&gt;90s)</div>
				<div class="text-base font-mono tabular-nums">{trend.slowBootCount}</div>
			</div>
		</div>

		{#if trend.latest.startupItemCount > 0}
			<div class="text-xs text-near-black/60">
				{trend.latest.startupItemCount} startup items · source: {trend.latest.source || '—'}
			</div>
		{/if}

		{#if trend.history.length > 1}
			<details class="mt-3">
				<summary class="text-xs text-near-black/60 cursor-pointer hover:text-near-black">Show history ({trend.history.length} boots)</summary>
				<table class="w-full mt-2 text-xs">
					<thead>
						<tr class="text-near-black/60 border-b border-border">
							<th class="text-left py-1">Boot time</th>
							<th class="text-right py-1">Total</th>
							<th class="text-right py-1">BIOS</th>
							<th class="text-right py-1">Loader</th>
							<th class="text-right py-1">Desktop</th>
							<th class="text-right py-1">Startup</th>
						</tr>
					</thead>
					<tbody>
						{#each trend.history as boot (boot.bootTimestamp)}
							<tr class="border-b border-border/50">
								<td class="py-1 tabular-nums">{fmtTs(boot.bootTimestamp)}</td>
								<td class="py-1 text-right tabular-nums {totalColor(boot.totalBootSeconds)}">{fmtSec(boot.totalBootSeconds)}</td>
								<td class="py-1 text-right tabular-nums">{fmtSec(boot.biosSeconds)}</td>
								<td class="py-1 text-right tabular-nums">{fmtSec(boot.osLoaderSeconds)}</td>
								<td class="py-1 text-right tabular-nums">{fmtSec(boot.desktopReadySeconds)}</td>
								<td class="py-1 text-right tabular-nums">{boot.startupItemCount}</td>
							</tr>
						{/each}
					</tbody>
				</table>
			</details>
		{/if}
	{/if}
</Card>
