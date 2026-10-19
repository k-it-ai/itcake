<script lang="ts">
	import { goto } from '$app/navigation';
	import TopBar from '#lib/components/shell/TopBar.svelte';
	import Card from '#lib/components/ui/Card.svelte';
	import Pager from '#lib/components/ui/Pager.svelte';
	import Tag from '#lib/components/ui/Tag.svelte';
	import EmptyState from '#lib/components/ui/EmptyState.svelte';
	import Btn from '#lib/components/ui/Btn.svelte';
	import { Download } from '#lib/icons/index.js';
	import { t } from '#lib/i18n/index.svelte.js';
	import { formatDate as fmtDate } from '#lib/format-date.js';
	import type { Change } from '#lib/types.js';
	import type { PageData } from './$types.js';

	let { data }: { data: PageData } = $props();

	let actionLabels = $derived<Record<string, string>>({
		create: t('changes.created'),
		update: t('changes.updated'),
		delete: t('changes.deleted'),
		status_change: t('changes.statusChanged'),
		reopen: t('changes.reopened'),
		send_email: t('changes.emailSent'),
		connect: t('changes.connected'),
		disconnect: t('changes.disconnected')
	});

	type Tone = 'brand' | 'good' | 'warn' | 'bad' | 'neutral' | 'accent';
	const actionTone: Record<string, Tone> = {
		create: 'brand',
		update: 'neutral',
		delete: 'bad',
		status_change: 'warn',
		reopen: 'brand',
		send_email: 'accent',
		connect: 'good',
		disconnect: 'warn'
	};

	const dateFormat = data.settings?.general?.dateFormat || 'DD/MM/YYYY';

	function formatDate(iso: string): string {
		return fmtDate(iso, dateFormat + ' HH:mm');
	}

	function shortTime(iso: string): string {
		return fmtDate(iso, 'DD MMM · HH:mm');
	}

	const entityPaths: Record<string, string> = {
		invoice: '/invoices',
		creditNote: '/invoices',
		proposal: '/proposals',
		client: '/clients',
		agent: '/agents'
	};

	function entityUrl(change: Change): string | null {
		if (change.action === 'delete') return null;
		const base = entityPaths[change.entityType];
		return base ? `${base}/${change.entityId}` : null;
	}

	function entityLabel(change: Change): string {
		return data.entityLabels[change.entityId] ?? change.entityId?.slice(0, 8) ?? '-';
	}

	function diffSummary(change: Change): { key: string; old: string; new: string } | null {
		if (!change.diff) return null;
		const keys = Object.keys(change.diff);
		if (keys.length === 0) return null;
		const k = keys[0];
		const v = change.diff[k];
		if (!v) return null;
		const fmt = (x: unknown) => {
			if (x === null || x === undefined) return '—';
			if (typeof x === 'string') return x;
			return JSON.stringify(x);
		};
		let oldVal = fmt(v.old);
		let newVal = fmt(v.new);
		if (k === 'status' && change.action === 'status_change') {
			oldVal = t('status.' + v.old);
			newVal = t('status.' + v.new);
		}
		return { key: k, old: oldVal, new: newVal };
	}

	function entityTypeLabel(change: Change): string {
		return t('entityType.' + change.entityType) || change.entityType;
	}

	function goToPage(page: number) {
		const url = new URL(window.location.href);
		if (page > 1) url.searchParams.set('page', String(page));
		else url.searchParams.delete('page');
		goto(url.pathname + url.search, { replaceState: true });
	}

	function toggleDir() {
		const url = new URL(window.location.href);
		url.searchParams.set('dir', data.dir === 'desc' ? 'asc' : 'desc');
		url.searchParams.delete('page');
		goto(url.pathname + url.search, { replace: true, reset: false });
	}
</script>

<svelte:head><title>{t('page.changes')} | ITCake</title></svelte:head>

<TopBar title={t('changes.title')} sub={t('audit.subtitle')} breadcrumb={[t('crumb.operations'), t('changes.title')]}>
	{#snippet right()}
		<Btn variant="ghost" size="sm" href="/api/exports?kind=audit">
			{#snippet icon()}<Download size={14} strokeWidth={1.6} />{/snippet}
			{t('action.exportCsv')}
		</Btn>
	{/snippet}
</TopBar>

<div class="p-5 space-y-4">
	<Card padding={0}>
		<div class="flex items-center justify-between gap-3 px-4 py-2.5 border-b" style="border-color:var(--line-2)">
			<span class="text-[12px]" style="color:var(--muted)">{t('audit.allActions')}</span>
			<div class="flex items-center gap-3">
				<span class="num text-[12px]" style="color:var(--muted)">
					{data.total} {data.total === 1 ? t('audit.eventSingular') : t('audit.eventPlural')}
				</span>
				<button
					type="button"
					class="text-[11.5px] underline-offset-2 hover:underline"
					style="color:var(--muted)"
					onclick={toggleDir}
				>
					{data.dir === 'desc' ? t('audit.newestFirst') : t('audit.oldestFirst')}
				</button>
			</div>
		</div>

		{#if data.changes.length === 0}
			<EmptyState title={t('empty.noChanges')} description={t('empty.changesDescription')} />
		{:else}
			{#each data.changes as change (change.id)}
				{@const diff = diffSummary(change)}
				{@const url = entityUrl(change)}
				<div
					class="flex items-start gap-3 px-4 py-3 border-t first:border-t-0"
					style="border-color:var(--line-2)"
				>
					<div class="font-mono text-[10.5px] shrink-0" style="color:var(--muted); width:120px">
						{shortTime(change.createdAt)}
					</div>
					<div class="flex items-center gap-2 shrink-0" style="width:160px">
						<div
							class="flex h-5 w-5 items-center justify-center rounded text-[10px] font-semibold"
							style="background:#eef0f4; color:#3a424c"
							aria-hidden="true"
						>
							{(change.userId?.[0] ?? 'S').toUpperCase()}
						</div>
						<span class="truncate text-[12px]" style="color:var(--ink)">
							{change.userId || t('audit.actorSystem')}
						</span>
					</div>
					<div class="min-w-0 flex-1">
						<div class="flex items-center gap-2 text-[12.5px] flex-wrap">
							<Tag tone={actionTone[change.action] ?? 'brand'}>
								{actionLabels[change.action] ?? change.action}
							</Tag>
							<span style="color:var(--muted)">{entityTypeLabel(change)}</span>
							<span class="font-medium font-mono text-[11.5px]" style="color:var(--ink)">
								{entityLabel(change)}
							</span>
						</div>
						{#if diff}
							<div class="mt-1 font-mono text-[11.5px] flex items-center gap-2 flex-wrap">
								<span style="color:var(--muted)">{diff.key}:</span>
								<span class="line-through" style="color:var(--muted)">{diff.old}</span>
								<span aria-hidden="true" style="color:#9aa3ad">→</span>
								<span style="color:var(--ink)">{diff.new}</span>
							</div>
						{/if}
						<div class="mt-0.5 text-[10.5px]" style="color:var(--muted)">
							{formatDate(change.createdAt)}
						</div>
					</div>
					<div class="shrink-0 self-center">
						{#if url}
							<a class="text-[11.5px] underline-offset-2 hover:underline" style="color:var(--muted)" href={url}>
								{t('action.open')}
							</a>
						{/if}
					</div>
				</div>
			{/each}
		{/if}
		<Pager total={data.total} page={data.page} pageSize={data.pageSize} onchange={goToPage} />
	</Card>
</div>