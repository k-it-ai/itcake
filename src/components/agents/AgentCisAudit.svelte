<script lang="ts">
	import Card from '$components/ui/Card.svelte';
	import Button from '$components/ui/Button.svelte';
	import { toast } from '$components/ui/Toast.svelte';
	import { api, getErrorMessage } from '$lib/api.js';
	import { invalidateAll } from '$app/navigation';
	import type { CisView } from '$services/cis-audit.js';

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
		if (s >= 85) return 'text-emerald-700 dark:text-emerald-300';
		if (s >= 65) return 'text-amber-700 dark:text-amber-300';
		return 'text-red-700 dark:text-red-300';
	}

	function statusBadge(s: string): string {
		switch (s) {
			case 'pass': return 'text-emerald-700 dark:text-emerald-300 bg-emerald-500/10';
			case 'fail': return 'text-red-700 dark:text-red-300 bg-red-500/10';
			case 'not_applicable': return 'text-near-black/60 bg-near-black/5';
			default: return 'text-amber-700 dark:text-amber-300 bg-amber-500/10';
		}
	}

	function severityBadge(s: string): string {
		switch (s) {
			case 'high': return 'text-red-700 dark:text-red-300';
			case 'medium': return 'text-amber-700 dark:text-amber-300';
			default: return 'text-near-black/60';
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
	<div class="flex items-baseline justify-between mb-3">
		<h3 class="text-sm font-semibold text-near-black">CIS hardening audit</h3>
		<Button size="sm" variant="secondary" onclick={audit} loading={busy} {disabled}>Run audit</Button>
	</div>

	{#if !view.latest}
		<p class="text-xs text-near-black/60">No audit run yet. Click "Run audit" — detection-only, takes ~30s.</p>
	{:else}
		<div class="grid grid-cols-2 gap-3 sm:grid-cols-4 mb-4">
			<div>
				<div class="text-xs text-near-black/60">Score</div>
				<div class="text-2xl font-semibold tabular-nums {scoreColor(view.latest.score)}">{view.latest.score}<span class="text-sm text-near-black/40">/100</span></div>
			</div>
			<div>
				<div class="text-xs text-near-black/60">Passed</div>
				<div class="text-2xl font-semibold tabular-nums text-emerald-700 dark:text-emerald-300">{view.latest.passedChecks}</div>
			</div>
			<div>
				<div class="text-xs text-near-black/60">Failed</div>
				<div class="text-2xl font-semibold tabular-nums text-red-700 dark:text-red-300">{view.latest.failedChecks}</div>
			</div>
			<div>
				<div class="text-xs text-near-black/60">Total</div>
				<div class="text-2xl font-semibold tabular-nums">{view.latest.totalChecks}</div>
			</div>
		</div>

		<div class="text-xs text-near-black/60 mb-3">
			Checked {new Date(view.latest.checkedAt).toLocaleString('de-DE', { dateStyle: 'short', timeStyle: 'short' })} · {view.latest.platform}
		</div>

		<table class="w-full text-xs">
			<thead>
				<tr class="text-near-black/60 border-b border-border">
					<th class="text-left py-1 w-20">Check</th>
					<th class="text-left py-1">Title</th>
					<th class="text-left py-1 w-20">Severity</th>
					<th class="text-left py-1 w-24">Status</th>
				</tr>
			</thead>
			<tbody>
				{#each view.latest.findings as f (f.checkId)}
					<tr class="border-b border-border/50">
						<td class="py-1 font-mono">{f.checkId}</td>
						<td class="py-1">
							{f.title}
							{#if f.message}
								<div class="text-[11px] text-near-black/50 mt-0.5">{f.message}</div>
							{/if}
						</td>
						<td class="py-1 {severityBadge(f.severity)}">{f.severity}</td>
						<td class="py-1">
							<span class="rounded-full px-1.5 py-0.5 text-[10px] {statusBadge(f.status)}">{f.status}</span>
						</td>
					</tr>
				{/each}
			</tbody>
		</table>
	{/if}
</Card>
