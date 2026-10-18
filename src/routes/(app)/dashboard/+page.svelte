<script lang="ts">
	import TopBar from '#lib/components/shell/TopBar.svelte';
	import Card from '#lib/components/ui/Card.svelte';
	import Btn from '#lib/components/ui/Btn.svelte';
	import StatusPill from '#lib/components/ui/StatusPill.svelte';
	import Tag from '#lib/components/ui/Tag.svelte';
	import SectionHead from '#lib/components/ui/SectionHead.svelte';
	import Bar from '#lib/components/ui/Bar.svelte';
	import Dot from '#lib/components/ui/Dot.svelte';
	import Spark from '#lib/components/ui/Spark.svelte';
	import { invoiceStatusTone, proposalStatusTone } from '#lib/select-options.js';
	import { formatMoney } from '#lib/money.js';
	import { formatDate } from '#lib/format-date.js';
	import { t } from '#lib/i18n/index.svelte.js';
	import type { PageData } from './$types.js';

	let { data }: { data: PageData } = $props();

	const currency = data.settings?.general?.currency ?? 'EUR';
	const dateFormat = data.settings?.general?.dateFormat || 'DD/MM/YYYY';
	const monthLabels = $derived(Array.from({ length: 12 }, (_, i) => t(`month.${i}`)));

	const chartWidth = 700;
	const chartHeight = 200;
	const barGap = 8;
	const barWidth = (chartWidth - barGap * 13) / 12;
	const monthlyRevenue = data.monthlyRevenue?.length ? data.monthlyRevenue : Array(12).fill(0);
	const maxRevenue = Math.max(...monthlyRevenue, 1);

	const greeting = $derived(`${t('dashboard.title')} · ${data.currentYear}`);
</script>

<svelte:head><title>{t('dashboard.title')} | ITCake</title></svelte:head>

<TopBar title={t('dashboard.title')} sub={greeting} breadcrumb={['Workspace', t('dashboard.title')]}>
	{#snippet right()}
		<Btn variant="ghost" size="sm" href="/invoices">{t('dashboard.viewAll')}</Btn>
		<Btn variant="primary" size="sm" href="/invoices/new">+ {t('invoice.new')}</Btn>
	{/snippet}
</TopBar>

<div class="p-5 space-y-5">
	{#if data.stats.totalInvoices === 0 && data.totalClients === 0}
		<Card padding={20} class="border-[color:var(--brand-soft)]">
			<h2 class="text-[13px] font-semibold mb-1" style="color:var(--ink)">{t('dashboard.getStarted')}</h2>
			<p class="text-[11.5px] mb-4" style="color:var(--muted)">{t('dashboard.welcomeMessage')}</p>
			<div class="grid grid-cols-1 sm:grid-cols-3 gap-3">
				<a href="/settings#company" class="flex items-center gap-3 p-3 rounded-md border transition-colors hover:bg-[var(--brand-soft)]" style="border-color:var(--line)">
					<span class="flex items-center justify-center h-8 w-8 rounded-full text-[12px] font-bold num" style="background:var(--brand-soft);color:var(--brand-ink)">1</span>
					<div class="min-w-0"><p class="text-[12.5px] font-medium truncate" style="color:var(--ink)">{t('dashboard.stepCompanySettings')}</p><p class="text-[11px] truncate" style="color:var(--muted)">{t('dashboard.stepCompanySettingsDesc')}</p></div>
				</a>
				<a href="/clients" class="flex items-center gap-3 p-3 rounded-md border transition-colors hover:bg-[var(--brand-soft)]" style="border-color:var(--line)">
					<span class="flex items-center justify-center h-8 w-8 rounded-full text-[12px] font-bold num" style="background:var(--brand-soft);color:var(--brand-ink)">2</span>
					<div class="min-w-0"><p class="text-[12.5px] font-medium truncate" style="color:var(--ink)">{t('dashboard.stepAddClient')}</p><p class="text-[11px] truncate" style="color:var(--muted)">{t('dashboard.stepAddClientDesc')}</p></div>
				</a>
				<a href="/invoices/new" class="flex items-center gap-3 p-3 rounded-md border transition-colors hover:bg-[var(--brand-soft)]" style="border-color:var(--line)">
					<span class="flex items-center justify-center h-8 w-8 rounded-full text-[12px] font-bold num" style="background:var(--brand-soft);color:var(--brand-ink)">3</span>
					<div class="min-w-0"><p class="text-[12.5px] font-medium truncate" style="color:var(--ink)">{t('dashboard.stepCreateInvoice')}</p><p class="text-[11px] truncate" style="color:var(--muted)">{t('dashboard.stepCreateInvoiceDesc')}</p></div>
				</a>
			</div>
		</Card>
	{/if}

	<div class="grid grid-cols-2 lg:grid-cols-4 gap-3">
		<Card>
			<p class="text-[11.5px]" style="color:var(--muted)">{t('client.titlePlural')}</p>
			<p class="mt-1 text-[22px] font-semibold tracking-tight num" style="color:var(--ink)">{data.totalClients}</p>
		</Card>
		<Card>
			<p class="text-[11.5px]" style="color:var(--muted)">{t('invoice.titlePlural')}</p>
			<p class="mt-1 text-[22px] font-semibold tracking-tight num" style="color:var(--ink)">{data.stats.totalInvoices}</p>
			<div class="mt-2 flex flex-wrap gap-1">
				{#if data.stats.totalDraft > 0}<Tag tone="neutral">{t('badge.draft', { count: data.stats.totalDraft })}</Tag>{/if}
				{#if data.stats.totalSent > 0}<Tag tone="brand">{t('badge.sent', { count: data.stats.totalSent })}</Tag>{/if}
			</div>
		</Card>
		<Card>
			<div class="flex items-start justify-between gap-2">
				<div class="min-w-0">
					<p class="text-[11.5px]" style="color:var(--muted)">{t('dashboard.paid')} {t('dashboard.thisYear')}</p>
					<p class="mt-1 text-[22px] font-semibold tracking-tight num" style="color:var(--brand-ink)">{data.stats.totalPaid}</p>
					<p class="mt-1 text-[11px] num" style="color:var(--muted)">{t('dashboard.total')} {formatMoney(data.yearlyRevenue, currency)}</p>
				</div>
				{#if monthlyRevenue.some((v) => v > 0)}
					<Spark data={monthlyRevenue} class="shrink-0" ariaLabel={t('aria.monthlyRevenueChart', { year: data.currentYear, total: formatMoney(data.yearlyRevenue, currency) })} />
				{/if}
			</div>
		</Card>
		<Card>
			<p class="text-[11.5px]" style="color:var(--muted)">{t('dashboard.outstanding')}</p>
			<p class="mt-1 text-[22px] font-semibold tracking-tight num" style="color:var(--bad)">{formatMoney(data.totalUnpaid, currency)}</p>
			<p class="mt-1 text-[11px] num" style="color:var(--muted)">{t('dashboard.unpaidInvoices', { count: data.unpaidCount })}</p>
			{#if data.stats.totalOverdue > 0}
				<div class="mt-2"><Tag tone="bad">{t('badge.overdue', { count: data.stats.totalOverdue })}</Tag></div>
			{/if}
		</Card>
	</div>

	<Card padding={16}>
		<SectionHead
			title="{t('dashboard.revenue')} {data.currentYear}"
			sub="{t('dashboard.total')} {formatMoney(data.yearlyRevenue, currency)} · {t('dashboard.avg')} {formatMoney(data.avgPerMonth, currency)}{t('dashboard.perMonth')}"
		/>
		<div class="overflow-x-auto">
			<svg viewBox="0 0 {chartWidth} {chartHeight + 30}" class="w-full" style="max-height: 240px;" role="img" aria-label={t('aria.monthlyRevenueChart', { year: data.currentYear, total: formatMoney(data.yearlyRevenue, currency) })}>
				{#each monthlyRevenue as revenue, i}
					{@const barHeight = maxRevenue > 0 ? (revenue / maxRevenue) * chartHeight : 0}
					{@const x = barGap + i * (barWidth + barGap)}
					{@const y = chartHeight - barHeight}
					<rect
						{x} {y}
						width={barWidth}
						height={Math.max(barHeight, 1)}
						rx="4"
						style="fill:var(--brand)"
						opacity="0.85"
					/>
					<text x={x + barWidth / 2} y={chartHeight + 18} text-anchor="middle" style="fill:var(--muted);font-size:10.5px">{monthLabels[i]}</text>
					{#if revenue > 0 && barHeight > 20}
						<text x={x + barWidth / 2} y={y - 4} text-anchor="middle" style="fill:var(--muted);font-size:10px" class="num">{formatMoney(revenue, currency)}</text>
					{/if}
				{/each}
			</svg>
		</div>
	</Card>

	<div class="grid grid-cols-1 lg:grid-cols-12 gap-5">
		<Card class="lg:col-span-7" padding={0}>
			<div class="px-4 pt-4 pb-2">
				<SectionHead title="{t('dashboard.unpaid')} {t('invoice.titlePlural')}">
					{#snippet right()}
						<span class="text-[12.5px] font-semibold num" style="color:var(--bad)">{formatMoney(data.totalUnpaid, currency)}</span>
					{/snippet}
				</SectionHead>
			</div>
			{#if data.unpaidInvoices.length === 0}
				<p class="px-4 pb-4 text-[12px]" style="color:var(--muted)">{t('empty.allInvoicesPaid')}</p>
			{:else}
				<div class="border-t" style="border-color:var(--line-2)">
					{#each data.unpaidInvoices.slice(0, 8) as invoice}
						<a href="/invoices/{invoice.id}" class="flex items-center justify-between gap-3 px-4 py-2.5 border-b transition-colors hover:bg-[var(--brand-soft)]" style="border-color:var(--line-2)">
							<div class="min-w-0">
								<p class="text-[11.5px] font-medium font-mono truncate" style="color:var(--ink)">{invoice.documentId}</p>
								<p class="text-[11px] truncate" style="color:var(--muted)">{invoice.buyer?.name ?? ''} · {t('dashboard.due')} {invoice.dueDate ? formatDate(invoice.dueDate, dateFormat) : '—'}</p>
							</div>
							<div class="text-right shrink-0 flex items-center gap-2">
								<p class="text-[12.5px] font-medium num" style="color:var(--ink)">{formatMoney(invoice.totals.total, invoice.currency)}</p>
								<Tag tone={invoiceStatusTone(invoice.status)}>{t('status.' + invoice.status)}</Tag>
							</div>
						</a>
					{/each}
				</div>
				{#if data.unpaidInvoices.length > 8}
					<a href="/invoices" class="block text-center text-[12px] py-2.5 transition-colors hover:bg-[var(--brand-soft)]" style="color:var(--brand)">{t('dashboard.viewAllUnpaid', { count: data.unpaidCount })}</a>
				{/if}
			{/if}
		</Card>

		<div class="lg:col-span-5 space-y-5">
			<Card padding={16}>
				<SectionHead title={t('dashboard.topClients')} />
				{#if data.topClients.length === 0}
					<p class="text-[12px]" style="color:var(--muted)">{t('empty.noRevenueData')}</p>
				{:else}
					{@const topMax = Math.max(...data.topClients.map(c => c.total), 1)}
					<div class="space-y-2.5">
						{#each data.topClients as client, i}
							<div class="flex items-center gap-3">
								<span class="text-[10.5px] font-medium num w-4 text-right" style="color:var(--muted)">{i + 1}</span>
								<span class="text-[12.5px] truncate flex-1" style="color:var(--ink)">{client.name}</span>
								<span class="text-[12.5px] font-medium num shrink-0" style="color:var(--ink)">{formatMoney(client.total, currency)}</span>
								<div class="w-20 shrink-0"><Bar pct={(client.total / topMax) * 100} tone="brand" /></div>
							</div>
						{/each}
					</div>
				{/if}
			</Card>

			{#if !data.isKleinunternehmer}
				<Card padding={16}>
					<SectionHead
						title={t('dashboard.taxSummary', { year: data.currentYear })}
					>
						{#snippet right()}
							<span class="text-[14px] font-semibold num" style="color:var(--ink)">{formatMoney(data.yearlyTax, currency)}</span>
						{/snippet}
					</SectionHead>
					<p class="text-[11.5px]" style="color:var(--muted)">{t('dashboard.totalTaxCollected')}</p>
					<div class="mt-3 grid grid-cols-4 gap-2">
						{#each data.monthlyTax as tax, i}
							{#if tax > 0}
								<div class="text-center">
									<p class="text-[10.5px] uppercase tracking-wider" style="color:var(--muted)">{monthLabels[i]}</p>
									<p class="text-[11.5px] font-medium num" style="color:var(--ink)">{formatMoney(tax, currency)}</p>
								</div>
							{/if}
						{/each}
					</div>
				</Card>
			{:else}
				<Card>
					<div class="flex items-center gap-2">
						<Tag tone="brand">§19 UStG</Tag>
						<p class="text-[12px]" style="color:var(--muted)">{t('dashboard.kuActive')}</p>
					</div>
				</Card>
			{/if}
		</div>
	</div>

	{#if data.recoveryReadiness}
		{@const r = data.recoveryReadiness}
		{@const scoreTone = r.score >= 80 ? 'good' : r.score >= 50 ? 'warn' : 'bad'}
		{@const ringColor = r.score >= 80 ? 'var(--good)' : r.score >= 50 ? 'var(--warn)' : 'var(--bad)'}
		<Card padding={16}>
			<div class="flex items-start justify-between gap-4">
				<div class="flex items-center gap-4">
					<svg class="size-20 shrink-0" viewBox="0 0 36 36" aria-hidden="true">
						<path style="fill:none;stroke:var(--line-2)" stroke-width="3" d="M18 2.0845 a 15.9155 15.9155 0 0 1 0 31.831 a 15.9155 15.9155 0 0 1 0 -31.831" />
						<path style="fill:none;stroke:{ringColor}" stroke-width="3" stroke-linecap="round" stroke-dasharray={`${r.score}, 100`} d="M18 2.0845 a 15.9155 15.9155 0 0 1 0 31.831 a 15.9155 15.9155 0 0 1 0 -31.831" />
					</svg>
					<div>
						<h3 class="text-[13px] font-semibold" style="color:var(--ink)">Backup recovery readiness</h3>
						<p class="mt-1 text-[24px] font-semibold tracking-tight num" style="color:{ringColor}">{r.score}<span class="text-[13px] font-normal" style="color:var(--muted)"> / 100</span></p>
					</div>
				</div>
				<a href="/settings#backup" class="text-[12px] whitespace-nowrap" style="color:var(--brand)">Settings →</a>
			</div>
			{#if r.riskFactors.length > 0}
				<ul class="mt-3 space-y-1">
					{#each r.riskFactors as factor}
						<li class="text-[12px] flex items-start gap-2" style="color:var(--ink)">
							<Dot tone={scoreTone} class="mt-1.5" />
							<span>{factor}</span>
						</li>
					{/each}
				</ul>
			{:else}
				<p class="mt-3 text-[12px]" style="color:var(--good)">All backup signals are healthy.</p>
			{/if}
			{#if data.recentVerifications && data.recentVerifications.length > 0}
				<div class="mt-3 pt-3 border-t space-y-1" style="border-color:var(--line-2)">
					{#each data.recentVerifications.slice(0, 3) as v}
						<div class="flex items-center justify-between text-[11.5px] gap-2">
							<span class="font-mono truncate" style="color:var(--muted)">{v.filename}</span>
							<span class="flex items-center gap-2 shrink-0">
								<Tag tone={v.status === 'passed' ? 'good' : 'bad'}>{v.type}</Tag>
								<span class="num" style="color:var(--muted)">{formatDate(v.completedAt, dateFormat)}</span>
							</span>
						</div>
					{/each}
				</div>
			{/if}
		</Card>
	{/if}

	<div class="grid grid-cols-1 lg:grid-cols-2 gap-5">
		<Card padding={0}>
			<div class="px-4 pt-4 pb-2">
				<SectionHead title={t('dashboard.recentInvoices')}>
					{#snippet right()}
						<a href="/invoices" class="text-[12px]" style="color:var(--brand)">{t('dashboard.viewAll')}</a>
					{/snippet}
				</SectionHead>
			</div>
			{#if data.recentInvoices.length === 0}
				<p class="px-4 pb-4 text-[12px]" style="color:var(--muted)">{t('dashboard.noInvoices')}</p>
			{:else}
				<div class="border-t" style="border-color:var(--line-2)">
					{#each data.recentInvoices as invoice}
						<a href="/invoices/{invoice.id}" class="flex items-center justify-between gap-3 px-4 py-2.5 border-b transition-colors hover:bg-[var(--brand-soft)]" style="border-color:var(--line-2)">
							<div class="min-w-0">
								<p class="text-[11.5px] font-medium font-mono truncate" style="color:var(--ink)">{invoice.documentId}</p>
								<p class="text-[11px] truncate" style="color:var(--muted)">{invoice.buyer?.name ?? ''}</p>
							</div>
							<div class="text-right shrink-0 flex items-center gap-2">
								<p class="text-[12.5px] font-medium num" style="color:var(--ink)">{formatMoney(invoice.totals.total, invoice.currency)}</p>
								<Tag tone={invoiceStatusTone(invoice.status)}>{t('status.' + invoice.status)}</Tag>
							</div>
						</a>
					{/each}
				</div>
			{/if}
		</Card>

		<Card padding={0}>
			<div class="px-4 pt-4 pb-2">
				<SectionHead title={t('dashboard.recentProposals')}>
					{#snippet right()}
						<a href="/proposals" class="text-[12px]" style="color:var(--brand)">{t('dashboard.viewAll')}</a>
					{/snippet}
				</SectionHead>
			</div>
			{#if data.recentProposals.length === 0}
				<p class="px-4 pb-4 text-[12px]" style="color:var(--muted)">{t('empty.noProposalsYet')}</p>
			{:else}
				<div class="border-t" style="border-color:var(--line-2)">
					{#each data.recentProposals as proposal}
						<a href="/proposals/{proposal.id}" class="flex items-center justify-between gap-3 px-4 py-2.5 border-b transition-colors hover:bg-[var(--brand-soft)]" style="border-color:var(--line-2)">
							<div class="min-w-0">
								<p class="text-[11.5px] font-medium font-mono truncate" style="color:var(--ink)">{proposal.documentId}</p>
								<p class="text-[11px] truncate" style="color:var(--muted)">{proposal.buyer?.name ?? ''}</p>
							</div>
							<div class="text-right shrink-0 flex items-center gap-2">
								<p class="text-[12.5px] font-medium num" style="color:var(--ink)">{formatMoney(proposal.totals.total, proposal.currency)}</p>
								<Tag tone={proposalStatusTone(proposal.status)}>{t('status.' + proposal.status)}</Tag>
							</div>
						</a>
					{/each}
				</div>
			{/if}
		</Card>
	</div>
</div>
