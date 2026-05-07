<script lang="ts">
	import Card from '$components/ui/Card.svelte';
	import type { SecurityPosture } from '$services/security-posture.js';

	let { posture }: { posture: SecurityPosture } = $props();

	function scoreColor(score: number): string {
		if (score >= 85) return 'text-emerald-600 dark:text-emerald-400';
		if (score >= 65) return 'text-amber-600 dark:text-amber-400';
		return 'text-red-600 dark:text-red-400';
	}
	function barColor(score: number): string {
		if (score >= 85) return 'bg-emerald-500';
		if (score >= 65) return 'bg-amber-500';
		return 'bg-red-500';
	}
	function pct(c: { earnedPoints: number; maxPoints: number }): number {
		return c.maxPoints === 0 ? 0 : Math.round((c.earnedPoints / c.maxPoints) * 100);
	}
	function labelFor(key: string): string {
		switch (key) {
			case 'sensitive_data': return 'Sensitive data';
			case 'policy': return 'Policy / CIS';
			case 'peripheral': return 'Peripheral';
			case 'network': return 'Network';
			case 'filesystem': return 'Filesystem';
			case 'reliability': return 'Reliability';
			default: return key;
		}
	}
</script>

<Card>
	<div class="flex items-baseline justify-between mb-3">
		<h3 class="text-sm font-semibold text-near-black">Security posture</h3>
		<div class="text-xs text-near-black/50">
			updated {new Date(posture.computedAt).toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit', hour12: false })}
		</div>
	</div>

	<div class="flex items-center gap-4 mb-4">
		<div class="text-3xl font-bold tabular-nums {scoreColor(posture.score)}">{posture.score}<span class="text-lg text-near-black/40">/100</span></div>
		<div class="flex-1">
			<div class="h-2 bg-near-black/10 rounded-full overflow-hidden">
				<div class="h-full {barColor(posture.score)} transition-all" style="width: {posture.score}%"></div>
			</div>
		</div>
	</div>

	<dl class="space-y-1.5 text-xs">
		{#each posture.components as c (c.key)}
			<div class="flex items-center gap-2">
				<dt class="w-28 text-near-black/60">{labelFor(c.key)}</dt>
				<dd class="flex-1 flex items-center gap-2">
					<div class="h-1 flex-1 bg-near-black/10 rounded">
						<div class="h-full {barColor(pct(c))} rounded transition-all" style="width: {pct(c)}%"></div>
					</div>
					<span class="text-near-black/70 tabular-nums w-10 text-right">{c.earnedPoints}/{c.maxPoints}</span>
				</dd>
			</div>
		{/each}
	</dl>

	{#if posture.riskFactors.length > 0}
		<ul class="mt-3 pt-3 border-t border-border space-y-1 text-xs text-near-black/70">
			{#each posture.riskFactors as f}
				<li class="flex gap-2"><span class="text-near-black/30">·</span><span>{f}</span></li>
			{/each}
		</ul>
	{/if}
</Card>
