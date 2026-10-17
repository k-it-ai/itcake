<script lang="ts">
	import Card from '#lib/components/ui/Card.svelte';
	import SectionHead from '#lib/components/ui/SectionHead.svelte';
	import Btn from '#lib/components/ui/Btn.svelte';
	import Tag from '#lib/components/ui/Tag.svelte';
	import { toast } from '#components/ui/Toast.svelte';
	import { api, getErrorMessage } from '#lib/api.js';
	import { invalidateAll } from '$app/navigation';
	import type { CisView } from '#services/cis-audit.js';

	let {
		agentId,
		view,
		disabled = false
	}: {
		agentId: string;
		view: CisView;
		disabled?: boolean;
	} = $props();

	let busy = $state(false);

	function scoreColor(s: number): string {
		if (s >= 85) return 'var(--good)';
		if (s >= 65) return 'var(--warn)';
		return 'var(--bad)';
	}

	type TagTone = 'good' | 'bad' | 'warn' | 'neutral';
	function statusTagTone(s: string): TagTone {
		switch (s) {
			case 'pass': return 'good';
			case 'fail': return 'bad';
			case 'not_applicable': return 'neutral';
			default: return 'warn';
		}
	}

	function severityColor(s: string): string {
		switch (s) {
			case 'high': return 'var(--bad)';
			case 'medium': return 'var(--warn)';
			default: return 'var(--muted)';
		}
	}

	async function audit() {
		busy = true;
		try {
			await api.post(`/api/agents/${agentId}/cis`, { action: 'audit' });
			toast('CIS audit dispatched (~30s)', 'success');
			setTimeout(() => invalidateAll(), 1500);
		} catch (e) {
			toast(getErrorMessage(e, 'Failed to dispatch'), 'error');
		} finally {
			busy = false;
		}
	}
</script>

<Card>
	<SectionHead title="CIS hardening audit">
		{#snippet right()}
			<Btn variant="soft" size="sm" onclick={audit} {disabled}>
				{busy ? 'Auditing…' : 'Run audit'}
			</Btn>
		{/snippet}
	</SectionHead>

	{#if !view.latest}
		<p class="text-[11.5px]" style="color:var(--muted)">No audit run yet. Click "Run audit" — detection-only, takes ~30s.</p>
	{:else}
		<div class="grid grid-cols-2 gap-3 sm:grid-cols-4 mb-4">
			<div>
				<div class="text-[11px]" style="color:var(--muted)">Score</div>
				<div class="text-[22px] font-semibold num" style="color:{scoreColor(view.latest.score)}">{view.latest.score}<span class="text-[13px]" style="color:var(--muted)">/100</span></div>
			</div>
			<div>
				<div class="text-[11px]" style="color:var(--muted)">Passed</div>
				<div class="text-[22px] font-semibold num" style="color:var(--good)">{view.latest.passedChecks}</div>
			</div>
			<div>
				<div class="text-[11px]" style="color:var(--muted)">Failed</div>
				<div class="text-[22px] font-semibold num" style="color:var(--bad)">{view.latest.failedChecks}</div>
			</div>
			<div>
				<div class="text-[11px]" style="color:var(--muted)">Total</div>
				<div class="text-[22px] font-semibold num" style="color:var(--ink)">{view.latest.totalChecks}</div>
			</div>
		</div>

		<div class="text-[11px] mb-3" style="color:var(--muted)">
			Checked {new Date(view.latest.checkedAt).toLocaleString('de-DE', { dateStyle: 'short', timeStyle: 'short' })} · {view.latest.platform}
		</div>

		<table class="w-full text-[11.5px]">
			<thead>
				<tr style="border-bottom:1px solid var(--line-2)">
					<th class="text-left py-1 w-20 text-[10.5px] uppercase tracking-wide font-medium" style="color:var(--muted)">Check</th>
					<th class="text-left py-1 text-[10.5px] uppercase tracking-wide font-medium" style="color:var(--muted)">Title</th>
					<th class="text-left py-1 w-20 text-[10.5px] uppercase tracking-wide font-medium" style="color:var(--muted)">Severity</th>
					<th class="text-left py-1 w-24 text-[10.5px] uppercase tracking-wide font-medium" style="color:var(--muted)">Status</th>
				</tr>
			</thead>
			<tbody>
				{#each view.latest.findings as f (f.checkId)}
					<tr style="border-bottom:1px solid var(--line-2)">
						<td class="py-1.5 font-mono num" style="color:var(--ink)">{f.checkId}</td>
						<td class="py-1.5" style="color:var(--ink)">
							{f.title}
							{#if f.message}
								<div class="text-[10.5px] mt-0.5" style="color:var(--muted)">{f.message}</div>
							{/if}
						</td>
						<td class="py-1.5" style="color:{severityColor(f.severity)}">{f.severity}</td>
						<td class="py-1.5">
							<Tag tone={statusTagTone(f.status)}>{f.status}</Tag>
						</td>
					</tr>
				{/each}
			</tbody>
		</table>
	{/if}
</Card>
