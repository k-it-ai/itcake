<script lang="ts">
	import TopBar from '$components/layout/TopBar.svelte';
	import Card from '$components/ui/Card.svelte';
	import Badge from '$components/ui/Badge.svelte';
	import DataTable from '$components/ui/DataTable.svelte';
	import EmptyState from '$components/ui/EmptyState.svelte';
	import { t } from '$lib/i18n/index.svelte.js';
	import { formatDate as fmtDate } from '$lib/format-date.js';
	import type { Change } from '$lib/types.js';
	import type { PageData } from './$types.js';

	let { data }: { data: PageData } = $props();

	let actionLabels = $derived<Record<string, string>>({
		create: t('changes.created'),
		update: t('changes.updated'),
		delete: t('changes.deleted'),
		status_change: t('changes.statusChanged')
	});

	const actionVariants: Record<string, 'success' | 'info' | 'danger' | 'warning'> = {
		create: 'success',
		update: 'info',
		delete: 'danger',
		status_change: 'warning'
	};

	const dateFormat = data.settings?.general?.dateFormat || 'DD/MM/YYYY';

	function formatDate(iso: string): string {
		return fmtDate(iso, dateFormat + ' HH:mm');
	}

	const entityPaths: Record<string, string> = {
		invoice: '/invoices',
		creditNote: '/invoices',
		proposal: '/proposals',
		client: '/clients'
	};

	function entityUrl(change: { entityType: string; entityId: string; action: string }): string | null {
		if (change.action === 'delete') return null;
		const base = entityPaths[change.entityType];
		return base ? `${base}/${change.entityId}` : null;
	}

	const columns = $derived([
		{ key: 'action', label: t('changes.columnAction'), sortable: true },
		{ key: 'entityType', label: t('changes.columnType'), sortable: true },
		{ key: 'entityId', label: t('changes.columnEntity') },
		{ key: 'detail', label: t('changes.columnDetail') },
		{ key: 'createdAt', label: t('changes.columnDate'), sortable: true },
	]);
</script>

<svelte:head><title>{t('page.changes')} | ITCake</title></svelte:head>

<TopBar title={t('changes.title')} />

<div class="p-6">
	{#if data.changes.length === 0}
		<Card>
			<EmptyState title={t('empty.noChanges')} description={t('empty.changesDescription')} />
		</Card>
	{:else}
		<Card flush>
			<DataTable
				{columns}
				data={data.changes}
				pageSize={25}
			>
				{#snippet row(change: Change)}
					<td class="px-4 py-3">
						<Badge variant={actionVariants[change.action] ?? 'default'}>
							{actionLabels[change.action] ?? change.action}
						</Badge>
					</td>
					<td class="px-4 py-3 text-sm font-medium">{t('entityType.' + change.entityType) || change.entityType}</td>
					<td class="px-4 py-3 text-sm">
						{#if entityUrl(change)}
							<a href={entityUrl(change)} class="text-cyan hover:text-cyan-dark hover:underline">{data.entityLabels[change.entityId] ?? change.entityId?.slice(0, 8) ?? '-'}</a>
						{:else}
							<span class="text-near-black/60">{data.entityLabels[change.entityId] ?? change.entityId?.slice(0, 8) ?? '-'}</span>
						{/if}
					</td>
					<td class="px-4 py-3 text-sm text-near-black/60">
						{#if change.action === 'status_change' && change.diff?.status}
							{t('status.' + change.diff.status.old)} &rarr; {t('status.' + change.diff.status.new)}
						{/if}
					</td>
					<td class="px-4 py-3 text-xs text-near-black/60">{formatDate(change.createdAt)}</td>
				{/snippet}
			</DataTable>
		</Card>
	{/if}
</div>
