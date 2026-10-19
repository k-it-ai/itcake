<script lang="ts">
	import Card from '#lib/components/ui/Card.svelte';
	import Tag from '#lib/components/ui/Tag.svelte';
	import Btn from '#lib/components/ui/Btn.svelte';
	import EmptyState from '#lib/components/ui/EmptyState.svelte';
	import { toast } from '#components/ui/Toast.svelte';
	import { formatDate } from '#lib/format-date.js';
	import { t } from '#lib/i18n/index.svelte.js';
	import type { AgentFinding, FindingState } from '#lib/types.js';

	interface Props {
		findings: AgentFinding[];
		dateFormat: string;
		emptyTitle?: string;
		emptyDescription?: string;
		onResolved?: () => void;
	}
	let { findings, dateFormat, emptyTitle = t('agents.findingsEmpty'), emptyDescription = t('agents.findingsEmptyHelp'), onResolved }: Props = $props();

	type Filter = 'open' | 'resolved' | 'accepted' | 'false_positive' | 'all';
	let filter = $state<Filter>('open');

	const visible = $derived(filter === 'all' ? findings : findings.filter(f => f.state === filter));

	type SeverityTone = 'bad' | 'warn' | 'neutral';
	const severityTone = (s: string): SeverityTone => {
		if (s === 'critical' || s === 'high') return 'bad';
		if (s === 'medium') return 'warn';
		return 'neutral';
	};

	async function setState(finding: AgentFinding, next: FindingState) {
		const res = await fetch(`/api/agents/${finding.agentId}/findings`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ action: 'set-state', findingId: finding.id, state: next })
		});
		if (!res.ok) {
			toast(t('agents.findingUpdateFailed', { status: res.status }), 'error');
			return;
		}
		toast(t('agents.findingMarked', { state: next }), 'success');
		onResolved?.();
	}

	function evidencePreview(evidence: Record<string, unknown>): string {
		const keys = Object.keys(evidence);
		if (keys.length === 0) return '';
		return keys.slice(0, 4).map(k => `${k}=${JSON.stringify(evidence[k]).slice(0, 80)}`).join(' · ');
	}

	const FILTERS: Filter[] = ['open', 'accepted', 'resolved', 'false_positive', 'all'];
</script>

<Card>
	<div class="flex items-center justify-between mb-4 flex-wrap gap-2">
		<div class="inline-flex items-center gap-0.5 rounded-md p-0.5" style="background:#fbfcfd;border:1px solid var(--line)">
			{#each FILTERS as f}
				<button
					class="rounded-[4px] px-2.5 py-1 text-[11.5px] font-medium transition-colors focus-visible:outline-2 focus-visible:outline-[var(--brand)] focus-visible:outline-offset-1"
					style={filter === f
						? 'background:var(--brand-soft);color:var(--brand-ink)'
						: 'background:transparent;color:var(--muted)'}
					aria-pressed={filter === f}
					onclick={() => filter = f}
				>{f.replace('_', ' ')}</button>
			{/each}
		</div>
		<span class="text-[11px] num" style="color:var(--muted)">{visible.length} / {findings.length}</span>
	</div>

	{#if visible.length === 0}
		<EmptyState title={emptyTitle} description={emptyDescription} />
	{:else}
		<ul class="space-y-3">
			{#each visible as f (f.id)}
				<li class="rounded-md border p-3 space-y-2" style="border-color:var(--line)">
					<div class="flex items-start justify-between gap-2">
						<div class="flex-1">
							<div class="flex items-center gap-2 mb-1">
								<Tag tone={severityTone(f.severity)}>{f.severity}</Tag>
								<span class="text-[11px]" style="color:var(--muted)">{f.category}</span>
							</div>
							<p class="text-[12.5px] font-medium" style="color:var(--ink)">{f.title}</p>
							{#if Object.keys(f.evidence).length > 0}
								<p class="text-[11px] mt-1 font-mono" style="color:var(--muted)">{evidencePreview(f.evidence)}</p>
							{/if}
						</div>
						<div class="text-right text-[11px] whitespace-nowrap" style="color:var(--muted)">
							<p>{t('agents.findingFirstSeen', { date: formatDate(f.firstSeenAt, dateFormat) })}</p>
							<p>{t('agents.findingLastSeen', { date: formatDate(f.lastSeenAt, dateFormat) })}</p>
						</div>
					</div>
					{#if f.state === 'open'}
						<div class="flex gap-2 pt-1">
							<Btn variant="ghost" size="sm" onclick={() => setState(f, 'accepted')}>{t('agents.findingAccept')}</Btn>
							<Btn variant="ghost" size="sm" onclick={() => setState(f, 'false_positive')}>{t('agents.findingFalsePositive')}</Btn>
							<Btn variant="primary" size="sm" onclick={() => setState(f, 'resolved')}>{t('agents.findingResolve')}</Btn>
						</div>
					{:else}
						<p class="text-[11px]" style="color:var(--muted)">{t('agents.findingMarkedState', { state: f.state.replace('_', ' ') })}{f.resolvedAt ? ` ${t('agents.findingResolvedOn', { date: formatDate(f.resolvedAt, dateFormat) })}` : ''}</p>
					{/if}
				</li>
			{/each}
		</ul>
	{/if}
</Card>
