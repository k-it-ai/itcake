<script lang="ts">
	import { t } from '$lib/i18n/index.svelte.js';
	import SearchInput from '$components/ui/SearchInput.svelte';
	import type { AgentService } from '$lib/types.js';

	interface Props {
		services: AgentService[];
	}

	let { services }: Props = $props();

	let filter = $state('');

	const filtered = $derived.by(() => {
		if (!filter) return services;
		const q = filter.toLowerCase();
		return services.filter(s => s.name.toLowerCase().includes(q));
	});

	const statusColors: Record<string, string> = {
		running: 'bg-green-500/10 text-green-700 dark:text-green-400',
		active: 'bg-green-500/10 text-green-700 dark:text-green-400',
		stopped: 'bg-red-500/10 text-red-700 dark:text-red-400',
		inactive: 'bg-near-black/5 text-near-black/60',
		unknown: 'bg-near-black/5 text-near-black/60'
	};
</script>

<div class="space-y-3">
	<SearchInput bind:value={filter} />

	{#if filtered.length > 0}
		<div class="overflow-x-auto rounded-lg border border-border">
			<table class="w-full text-sm">
				<thead>
					<tr class="border-b border-border bg-bg-card">
						<th class="px-3 py-2 text-left text-xs font-medium text-near-black/60">{t('agents.serviceName')}</th>
						<th class="px-3 py-2 text-left text-xs font-medium text-near-black/60">{t('agents.serviceStatus')}</th>
						<th class="px-3 py-2 text-left text-xs font-medium text-near-black/60">{t('agents.serviceEnabled')}</th>
					</tr>
				</thead>
				<tbody>
					{#each filtered as svc (svc.name)}
						<tr class="border-b border-border last:border-0">
							<td class="px-3 py-2 font-mono text-xs text-near-black">{svc.name}</td>
							<td class="px-3 py-2">
								<span class="inline-block rounded-full px-2 py-0.5 text-xs font-medium {statusColors[svc.status] ?? statusColors.unknown}">
									{svc.status}
								</span>
							</td>
							<td class="px-3 py-2 text-xs text-near-black/60">
								{svc.enabled === null ? '—' : svc.enabled ? 'Yes' : 'No'}
							</td>
						</tr>
					{/each}
				</tbody>
			</table>
		</div>
	{:else}
		<p class="text-sm text-near-black/60 text-center py-8">{t('agents.noServices')}</p>
	{/if}
</div>
