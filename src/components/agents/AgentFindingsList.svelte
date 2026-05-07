<script lang="ts">
	import Card from '$components/ui/Card.svelte';
	import Badge from '$components/ui/Badge.svelte';
	import Button from '$components/ui/Button.svelte';
	import EmptyState from '$components/ui/EmptyState.svelte';
	import { toast } from '$components/ui/Toast.svelte';
	import { formatDate } from '$lib/format-date.js';
	import type { AgentFinding, FindingState } from '$lib/types.js';

	interface Props {
		findings: AgentFinding[];
		dateFormat: string;
		emptyTitle?: string;
		emptyDescription?: string;
		onResolved?: () => void;
	}
	let { findings, dateFormat, emptyTitle = 'No findings', emptyDescription = 'Findings appear here when a collector flags something for review.', onResolved }: Props = $props();

	type Filter = 'open' | 'resolved' | 'accepted' | 'false_positive' | 'all';
	let filter = $state<Filter>('open');

	const visible = $derived(filter === 'all' ? findings : findings.filter(f => f.state === filter));

	const severityVariant = (s: string): 'success' | 'warning' | 'danger' => {
		if (s === 'critical' || s === 'high') return 'danger';
		if (s === 'medium') return 'warning';
		return 'success';
	};

	async function setState(finding: AgentFinding, next: FindingState) {
		const res = await fetch(`/api/agents/${finding.agentId}/findings`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ action: 'set-state', findingId: finding.id, state: next })
		});
		if (!res.ok) {
			toast(`Failed to update finding: ${res.status}`, 'error');
			return;
		}
		toast(`Finding marked ${next}`, 'success');
		onResolved?.();
	}

	function evidencePreview(evidence: Record<string, unknown>): string {
		const keys = Object.keys(evidence);
		if (keys.length === 0) return '';
		return keys.slice(0, 4).map(k => `${k}=${JSON.stringify(evidence[k]).slice(0, 80)}`).join(' · ');
	}
</script>

<Card>
	<div class="flex items-center justify-between mb-4">
		<div class="flex gap-1">
			{#each ['open', 'accepted', 'resolved', 'false_positive', 'all'] as f}
				<button
					class={'px-3 py-1.5 rounded-md text-sm ' + (filter === f ? 'bg-cyan text-white' : 'bg-bg-card text-near-black/70 hover:bg-bg')}
					onclick={() => filter = f as Filter}
				>{f.replace('_', ' ')}</button>
			{/each}
		</div>
		<span class="text-xs text-near-black/60 tabular-nums">{visible.length} / {findings.length}</span>
	</div>

	{#if visible.length === 0}
		<EmptyState title={emptyTitle} description={emptyDescription} />
	{:else}
		<ul class="space-y-3">
			{#each visible as f (f.id)}
				<li class="border border-border rounded-md p-3 space-y-2">
					<div class="flex items-start justify-between gap-2">
						<div class="flex-1">
							<div class="flex items-center gap-2 mb-1">
								<Badge variant={severityVariant(f.severity)}>{f.severity}</Badge>
								<span class="text-xs text-near-black/60">{f.category}</span>
							</div>
							<p class="text-sm font-medium">{f.title}</p>
							{#if Object.keys(f.evidence).length > 0}
								<p class="text-xs text-near-black/60 mt-1 font-mono">{evidencePreview(f.evidence)}</p>
							{/if}
						</div>
						<div class="text-right text-xs text-near-black/50 whitespace-nowrap">
							<p>first {formatDate(f.firstSeenAt, dateFormat)}</p>
							<p>last {formatDate(f.lastSeenAt, dateFormat)}</p>
						</div>
					</div>
					{#if f.state === 'open'}
						<div class="flex gap-2 pt-1">
							<Button size="sm" variant="ghost" onclick={() => setState(f, 'accepted')}>Accept</Button>
							<Button size="sm" variant="ghost" onclick={() => setState(f, 'false_positive')}>False positive</Button>
							<Button size="sm" variant="primary" onclick={() => setState(f, 'resolved')}>Resolve</Button>
						</div>
					{:else}
						<p class="text-xs text-near-black/50">Marked {f.state.replace('_', ' ')}{f.resolvedAt ? ` on ${formatDate(f.resolvedAt, dateFormat)}` : ''}</p>
					{/if}
				</li>
			{/each}
		</ul>
	{/if}
</Card>
