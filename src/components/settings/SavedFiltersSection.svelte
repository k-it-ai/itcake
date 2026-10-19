<script lang="ts">
	import { onMount } from 'svelte';
	import Card from '#lib/components/ui/Card.svelte';
	import SectionHead from '#lib/components/ui/SectionHead.svelte';
	import Btn from '#lib/components/ui/Btn.svelte';
	import EmptyState from '#lib/components/ui/EmptyState.svelte';
	import Tag from '#lib/components/ui/Tag.svelte';
	import { toast } from '#components/ui/Toast.svelte';
	import { api, getErrorMessage } from '#lib/api.js';
	import { t } from '#lib/i18n/index.svelte.js';

	interface SavedFilter {
		id: string;
		name: string;
		appliesTo: string;
		conditions: Array<{ field: string; operator: string; value?: unknown }>;
		orderBy?: string;
	}

	let filters = $state<SavedFilter[]>([]);
	let loading = $state(false);

	async function load() {
		loading = true;
		try {
			filters = await api.get<SavedFilter[]>('/api/saved-filters');
		} catch (e) {
			toast(getErrorMessage(e, t('toast.failedLoad')), 'error');
		} finally {
			loading = false;
		}
	}
	onMount(load);

	async function del(f: SavedFilter) {
		if (!confirm(t('savedFilter.confirmDelete'))) return;
		try {
			await api.post('/api/saved-filters', { action: 'delete', id: f.id });
			await load();
		} catch (e) {
			toast(getErrorMessage(e, t('toast.failedDelete')), 'error');
		}
	}

	function summary(f: SavedFilter): string {
		if (!f.conditions || f.conditions.length === 0) return '(no conditions)';
		return f.conditions.slice(0, 3).map(c => `${c.field} ${c.operator}${c.value !== undefined ? ' ' + JSON.stringify(c.value).slice(0, 24) : ''}`).join(' AND ') + (f.conditions.length > 3 ? ` AND +${f.conditions.length - 3}` : '');
	}
</script>

<div class="space-y-4">
	<Card padding={20}>
		<SectionHead title={t('savedFilter.title')} sub={t('savedFilter.help')} />

		{#if loading}
			<p class="text-[12px]" style="color:var(--muted)">…</p>
		{:else if filters.length === 0}
			<EmptyState title={t('savedFilter.empty')} description={t('savedFilter.emptyHelp')} />
		{:else}
			<div class="space-y-2">
				{#each filters as f (f.id)}
					<div class="flex items-center gap-3 p-3 rounded-md" style="background:#fbfcfd; border:1px solid var(--line-2)">
						<div class="flex-1 min-w-0">
							<div class="flex items-center gap-2 truncate">
								<span class="font-medium text-[12.5px]" style="color:var(--ink)">{f.name}</span>
								<Tag tone="neutral">{f.appliesTo}</Tag>
							</div>
							<div class="text-[11px] mt-0.5 font-mono truncate" style="color:var(--muted)">{summary(f)}</div>
						</div>
						<Btn size="sm" variant="dangerSoft" onclick={() => del(f)}>{t('action.delete')}</Btn>
					</div>
				{/each}
			</div>
		{/if}
	</Card>
</div>
