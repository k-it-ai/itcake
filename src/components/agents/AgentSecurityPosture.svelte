<script lang="ts">
	import Card from '#lib/components/ui/Card.svelte';
	import SectionHead from '#lib/components/ui/SectionHead.svelte';
	import Bar from '#lib/components/ui/Bar.svelte';
	import { t } from '#lib/i18n/index.svelte.js';
	import type { SecurityPosture } from '#services/security-posture.js';

	let { posture }: { posture: SecurityPosture } = $props();

	type Tone = 'good' | 'warn' | 'bad';
	function scoreTone(score: number): Tone {
		if (score >= 85) return 'good';
		if (score >= 65) return 'warn';
		return 'bad';
	}
	function scoreColor(tone: Tone): string {
		return tone === 'good' ? 'var(--good)' : tone === 'warn' ? 'var(--warn)' : 'var(--bad)';
	}
	function pct(c: { earnedPoints: number; maxPoints: number }): number {
		return c.maxPoints === 0 ? 0 : Math.round((c.earnedPoints / c.maxPoints) * 100);
	}
	function labelFor(key: string): string {
		switch (key) {
			case 'sensitive_data': return t('agents.postureSensitiveData');
			case 'policy': return t('agents.posturePolicy');
			case 'peripheral': return t('agents.posturePeripheral');
			case 'network': return t('agents.postureNetwork');
			case 'filesystem': return t('agents.postureFilesystem');
			case 'reliability': return t('agents.postureReliability');
			default: return key;
		}
	}
	const overallTone = $derived(scoreTone(posture.score));
</script>

<Card>
	<SectionHead
		title={t('agents.postureTitle')}
		sub={t('agents.postureUpdated', { date: new Date(posture.computedAt).toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit', hour12: false }) })}
	/>

	<div class="flex items-center gap-4 mb-4">
		<div class="text-[28px] font-semibold leading-none num" style="color:{scoreColor(overallTone)}">
			{posture.score}<span class="text-[14px]" style="color:var(--muted)">/100</span>
		</div>
		<div class="flex-1">
			<Bar pct={posture.score} tone={overallTone} ariaLabel={t('agents.postureOverallAria')} />
		</div>
	</div>

	<dl class="space-y-1.5 text-[11.5px]">
		{#each posture.components as c (c.key)}
			{@const componentPct = pct(c)}
			<div class="flex items-center gap-2">
				<dt class="w-28" style="color:var(--muted)">{labelFor(c.key)}</dt>
				<dd class="flex-1 flex items-center gap-2">
					<div class="flex-1">
						<Bar pct={componentPct} tone={scoreTone(componentPct)} ariaLabel="{labelFor(c.key)}{t('agents.postureScoreSuffix')}" />
					</div>
					<span class="num w-12 text-right" style="color:var(--ink)">{c.earnedPoints}/{c.maxPoints}</span>
				</dd>
			</div>
		{/each}
	</dl>

	{#if posture.riskFactors.length > 0}
		<ul class="mt-3 pt-3 space-y-1 text-[11.5px]" style="border-top:1px solid var(--line-2);color:var(--muted)">
			{#each posture.riskFactors as f}
				<li class="flex gap-2"><span style="color:var(--line)">·</span><span>{f}</span></li>
			{/each}
		</ul>
	{/if}
</Card>
