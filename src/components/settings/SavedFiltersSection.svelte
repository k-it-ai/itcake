<script lang="ts">
	import { onMount } from 'svelte';
	import Card from '$components/ui/Card.svelte';
	import Button from '$components/ui/Button.svelte';
	import EmptyState from '$components/ui/EmptyState.svelte';
	import { toast } from '$components/ui/Toast.svelte';
	import { api, getErrorMessage } from '$lib/api.js';
	import { t } from '$lib/i18n/index.svelte.js';

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
	<Card class="space-y-3">
		<div>
			<h3 class="text-lg font-semibold">{t('savedFilter.title')}</h3>
			<p class="text-xs text-near-black/60 mt-1">{t('savedFilter.help')}</p>
		</div>

		{#if loading}
			<p class="text-sm text-near-black/60">…</p>
		{:else if filters.length === 0}
			<EmptyState title={t('savedFilter.empty')} description={t('savedFilter.emptyHelp')} />
		{:else}
			<div class="space-y-2">
				{#each filters as f (f.id)}
					<div class="flex items-center gap-3 p-3 rounded border border-border bg-bg-card">
						<div class="flex-1 min-w-0">
							<div class="font-medium truncate">{f.name}</div>
							<div class="text-xs text-near-black/60 font-mono truncate">{f.appliesTo} · {summary(f)}</div>
						</div>
						<Button size="sm" variant="danger" onclick={() => del(f)}>{t('action.delete')}</Button>
					</div>
				{/each}
			</div>
		{/if}
	</Card>
</div>
