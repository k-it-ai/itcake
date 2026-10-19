<script lang="ts">
	import { t } from '#lib/i18n/index.svelte.js';
	import SearchInput from '#components/ui/SearchInput.svelte';
	import Card from '#lib/components/ui/Card.svelte';
	import Tag from '#lib/components/ui/Tag.svelte';
	import type { AgentService } from '#lib/types.js';

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

	type TagTone = 'neutral' | 'good' | 'bad';
	const statusTone: Record<string, TagTone> = {
		running: 'good',
		active: 'good',
		stopped: 'bad',
		inactive: 'neutral',
		unknown: 'neutral'
	};
</script>

<div class="space-y-3">
	<SearchInput bind:value={filter} />

	{#if filtered.length > 0}
		<Card padding={0}>
			<table class="w-full text-[12px]">
				<thead>
					<tr style="background:#fbfcfd;border-bottom:1px solid var(--line-2)">
						<th class="px-4 py-2 text-left text-[10.5px] uppercase tracking-wide font-medium" style="color:var(--muted)">{t('agents.serviceName')}</th>
						<th class="px-3 py-2 text-left text-[10.5px] uppercase tracking-wide font-medium" style="color:var(--muted)">{t('agents.serviceStatus')}</th>
						<th class="px-4 py-2 text-left text-[10.5px] uppercase tracking-wide font-medium" style="color:var(--muted)">{t('agents.serviceEnabled')}</th>
					</tr>
				</thead>
				<tbody class="divide-y" style="--tw-divide-opacity:1;border-color:var(--line-2)">
					{#each filtered as svc (svc.name)}
						<tr style="border-color:var(--line-2)">
							<td class="px-4 py-2 font-mono text-[11.5px]" style="color:var(--ink)">{svc.name}</td>
							<td class="px-3 py-2">
								<Tag tone={statusTone[svc.status] ?? 'neutral'}>{svc.status}</Tag>
							</td>
							<td class="px-4 py-2 text-[11.5px]" style="color:var(--muted)">
								{svc.enabled === null ? '—' : svc.enabled ? t('agents.yes') : t('agents.no')}
							</td>
						</tr>
					{/each}
				</tbody>
			</table>
		</Card>
	{:else}
		<p class="text-[12px] text-center py-8" style="color:var(--muted)">{t('agents.noServices')}</p>
	{/if}
</div>
