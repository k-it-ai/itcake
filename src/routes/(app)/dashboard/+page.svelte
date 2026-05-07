<script lang="ts">
	import TopBar from '$components/layout/TopBar.svelte';
	import Card from '$components/ui/Card.svelte';
	import Badge from '$components/ui/Badge.svelte';
	import { invoiceBadgeVariant, proposalBadgeVariant } from '$lib/select-options.js';
	import { formatMoney } from '$lib/money.js';
	import { formatDate } from '$lib/format-date.js';
	import { t } from '$lib/i18n/index.svelte.js';
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
</script>

<svelte:head><title>{t('dashboard.title')} | ITCake</title></svelte:head>

<TopBar title={t('dashboard.title')} />

<div class="p-6 space-y-6">
	{#if data.stats.totalInvoices === 0 && data.totalClients === 0}
		<Card class="bg-cyan/5 border-cyan/20">
			<h2 class="text-lg font-semibold mb-2">{t('dashboard.getStarted')}</h2>
			<p class="text-sm text-near-black/70 mb-4">{t('dashboard.welcomeMessage')}</p>
			<div class="grid grid-cols-1 sm:grid-cols-3 gap-4">
				<a href="/settings#company" class="flex items-center gap-3 p-3 rounded-lg bg-bg-card border border-border hover:border-cyan/40 transition-colors">
					<span class="flex items-center justify-center h-8 w-8 rounded-full bg-cyan/10 text-cyan font-bold text-sm">1</span>
					<div><p class="text-sm font-medium">{t('dashboard.stepCompanySettings')}</p><p class="text-xs text-near-black/60">{t('dashboard.stepCompanySettingsDesc')}</p></div>
				</a>
				<a href="/clients" class="flex items-center gap-3 p-3 rounded-lg bg-bg-card border border-border hover:border-cyan/40 transition-colors">
					<span class="flex items-center justify-center h-8 w-8 rounded-full bg-cyan/10 text-cyan font-bold text-sm">2</span>
					<div><p class="text-sm font-medium">{t('dashboard.stepAddClient')}</p><p class="text-xs text-near-black/60">{t('dashboard.stepAddClientDesc')}</p></div>
				</a>
				<a href="/invoices/new" class="flex items-center gap-3 p-3 rounded-lg bg-bg-card border border-border hover:border-cyan/40 transition-colors">
					<span class="flex items-center justify-center h-8 w-8 rounded-full bg-cyan/10 text-cyan font-bold text-sm">3</span>
					<div><p class="text-sm font-medium">{t('dashboard.stepCreateInvoice')}</p><p class="text-xs text-near-black/60">{t('dashboard.stepCreateInvoiceDesc')}</p></div>
				</a>
			</div>
		</Card>
	{/if}

	<!-- Revenue Chart (yearly view) -->
	<Card>
		<div class="flex items-center justify-between mb-4">
			<h2 class="text-lg font-semibold">{t('dashboard.revenue')} {data.currentYear}</h2>
			<div class="flex items-center gap-4">
				<span class="text-sm text-near-black/60">{t('dashboard.total')}: <span class="font-bold text-cyan">{formatMoney(data.yearlyRevenue, currency)}</span></span>
				<span class="text-sm text-near-black/60">{t('dashboard.avg')}: <span class="font-medium">{formatMoney(data.avgPerMonth, currency)}</span>{t('dashboard.perMonth')}</span>
			</div>
		</div>
		<div class="overflow-x-auto">
			<svg viewBox="0 0 {chartWidth} {chartHeight + 30}" class="w-full" style="max-height: 280px;" role="img" aria-label={t('aria.monthlyRevenueChart', { year: data.currentYear, total: formatMoney(data.yearlyRevenue, currency) })}>
				{#each monthlyRevenue as revenue, i}
					{@const barHeight = maxRevenue > 0 ? (revenue / maxRevenue) * chartHeight : 0}
					{@const x = barGap + i * (barWidth + barGap)}
					{@const y = chartHeight - barHeight}
					<rect
						{x} {y}
						width={barWidth}
						height={Math.max(barHeight, 1)}
						rx="3"
						class="fill-cyan/70 hover:fill-cyan transition-colors"
					/>
					<text x={x + barWidth / 2} y={chartHeight + 16} text-anchor="middle" class="fill-near-black/50" style="font-size: 10px;">{monthLabels[i]}</text>
					{#if revenue > 0 && barHeight > 20}
						<text x={x + barWidth / 2} y={y - 4} text-anchor="middle" class="fill-near-black/60" style="font-size: 10px;">{formatMoney(revenue, currency)}</text>
					{/if}
				{/each}
			</svg>
		</div>
	</Card>

	<!-- Stats Grid -->
	<div class="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
		<a href="/clients" class="block">
			<Card class="hover:border-cyan/40 transition-colors cursor-pointer h-full">
				<p class="text-sm font-medium text-near-black/60">{t('client.titlePlural')}</p>
				<p class="mt-1 text-2xl font-bold text-near-black">{data.totalClients}</p>
			</Card>
		</a>
		<a href="/invoices" class="block">
			<Card class="hover:border-cyan/40 transition-colors cursor-pointer h-full">
				<p class="text-sm font-medium text-near-black/60">{t('invoice.titlePlural')}</p>
				<p class="mt-1 text-2xl font-bold text-near-black">{data.stats.totalInvoices}</p>
				<div class="mt-2 flex gap-2 flex-wrap">
					{#if data.stats.totalDraft > 0}<Badge variant="default">{t('badge.draft', { count: data.stats.totalDraft })}</Badge>{/if}
					{#if data.stats.totalSent > 0}<Badge variant="info">{t('badge.sent', { count: data.stats.totalSent })}</Badge>{/if}
				</div>
			</Card>
		</a>
		<a href="/invoices?status=paid&dateFrom={data.currentYear}-01-01&dateTo={data.currentYear}-12-31" class="block">
			<Card class="hover:border-cyan/40 transition-colors cursor-pointer h-full">
				<p class="text-sm font-medium text-near-black/60">{t('dashboard.paid')} {t('dashboard.thisYear')}</p>
				<p class="mt-1 text-2xl font-bold text-cyan">{data.stats.totalPaid}</p>
				<p class="mt-1 text-xs text-near-black/60">{t('dashboard.total')} {formatMoney(data.yearlyRevenue, currency)}</p>
			</Card>
		</a>
		<a href="/invoices" class="block">
			<Card class="hover:border-cyan/40 transition-colors cursor-pointer h-full">
				<p class="text-sm font-medium text-near-black/60">{t('dashboard.outstanding')}</p>
				<p class="mt-1 text-2xl font-bold text-red">{formatMoney(data.totalUnpaid, currency)}</p>
				<p class="mt-1 text-xs text-near-black/60">{t('dashboard.unpaidInvoices', { count: data.unpaidCount })}</p>
				{#if data.stats.totalOverdue > 0}
					<Badge variant="danger" class="mt-2">{t('badge.overdue', { count: data.stats.totalOverdue })}</Badge>
				{/if}
			</Card>
		</a>
	</div>

	<div class="grid grid-cols-1 gap-6 lg:grid-cols-2">
		<!-- Unpaid Invoices -->
		<Card>
			<div class="flex items-center justify-between mb-4">
				<h2 class="text-lg font-semibold text-near-black">{t('dashboard.unpaid')} {t('invoice.titlePlural')}</h2>
				<span class="text-sm font-bold text-red">{formatMoney(data.totalUnpaid, currency)}</span>
			</div>
			{#if data.unpaidInvoices.length === 0}
				<p class="text-sm text-near-black/60 py-4">{t('empty.allInvoicesPaid')}</p>
			{:else}
				<div class="space-y-2">
					{#each data.unpaidInvoices.slice(0, 8) as invoice}
						<a href="/invoices/{invoice.id}" class="flex items-center justify-between py-2 hover:bg-bg/50 rounded px-2 -mx-2">
							<div>
								<p class="text-sm font-medium text-near-black">{invoice.documentId}</p>
								<p class="text-xs text-near-black/60">{invoice.buyer?.name ?? ''} &middot; {t('dashboard.due')} {invoice.dueDate ? formatDate(invoice.dueDate, dateFormat) : ''}</p>
							</div>
							<div class="text-right">
								<p class="text-sm font-medium tabular-nums">{formatMoney(invoice.totals.total, invoice.currency)}</p>
								<Badge variant={invoiceBadgeVariant(invoice.status)}>{t('status.' + invoice.status)}</Badge>
							</div>
						</a>
					{/each}
				</div>
				{#if data.unpaidInvoices.length > 8}
					<a href="/invoices" class="block text-center text-sm text-cyan hover:text-cyan-dark mt-3">{t('dashboard.viewAllUnpaid', { count: data.unpaidCount })}</a>
				{/if}
			{/if}
		</Card>

		<!-- Top Clients + Tax -->
		<div class="space-y-6">
			<Card>
				<h2 class="text-lg font-semibold mb-4">{t('dashboard.topClients')}</h2>
				{#if data.topClients.length === 0}
					<p class="text-sm text-near-black/60 py-2">{t('empty.noRevenueData')}</p>
				{:else}
					<div class="space-y-3">
						{#each data.topClients as client, i}
							<div class="flex items-center justify-between">
								<div class="flex items-center gap-3">
									<span class="text-xs font-bold text-near-black/50 w-5">#{i + 1}</span>
									<span class="text-sm font-medium">{client.name}</span>
								</div>
								<span class="text-sm font-medium tabular-nums">{formatMoney(client.total, currency)}</span>
							</div>
						{/each}
					</div>
				{/if}
			</Card>

			{#if !data.isKleinunternehmer}
				<Card>
					<h2 class="text-lg font-semibold mb-4">{t('dashboard.taxSummary', { year: data.currentYear })}</h2>
					<div class="flex items-center justify-between mb-3">
						<span class="text-sm text-near-black/60">{t('dashboard.totalTaxCollected')}</span>
						<span class="text-lg font-bold tabular-nums">{formatMoney(data.yearlyTax, currency)}</span>
					</div>
					<div class="grid grid-cols-4 gap-2">
						{#each data.monthlyTax as tax, i}
							{#if tax > 0}
								<div class="text-center">
									<p class="text-xs text-near-black/60">{monthLabels[i]}</p>
									<p class="text-xs font-medium tabular-nums">{formatMoney(tax, currency)}</p>
								</div>
							{/if}
						{/each}
					</div>
				</Card>
			{:else}
				<Card>
					<div class="flex items-center gap-3">
						<Badge variant="info">§19 UStG</Badge>
						<p class="text-sm text-near-black/60">{t('dashboard.kuActive')}</p>
					</div>
				</Card>
			{/if}
		</div>
	</div>

	{#if data.recoveryReadiness}
		{@const r = data.recoveryReadiness}
		{@const scoreColor = r.score >= 80 ? 'text-green-600' : r.score >= 50 ? 'text-yellow-600' : 'text-red-600'}
		{@const ringColor = r.score >= 80 ? 'stroke-green-500' : r.score >= 50 ? 'stroke-yellow-500' : 'stroke-red-500'}
		<Card>
			<div class="flex items-start justify-between gap-4">
				<div class="flex items-center gap-4">
					<svg class="size-20" viewBox="0 0 36 36">
						<path class="stroke-border fill-none" stroke-width="3" d="M18 2.0845 a 15.9155 15.9155 0 0 1 0 31.831 a 15.9155 15.9155 0 0 1 0 -31.831" />
						<path class={`${ringColor} fill-none`} stroke-width="3" stroke-linecap="round" stroke-dasharray={`${r.score}, 100`} d="M18 2.0845 a 15.9155 15.9155 0 0 1 0 31.831 a 15.9155 15.9155 0 0 1 0 -31.831" />
					</svg>
					<div>
						<h2 class="text-lg font-semibold">Backup recovery readiness</h2>
						<p class={`text-3xl font-bold tabular-nums ${scoreColor}`}>{r.score}<span class="text-base font-normal text-near-black/60"> / 100</span></p>
					</div>
				</div>
				<a href="/settings#backup" class="text-sm text-cyan hover:text-cyan-dark whitespace-nowrap">Settings →</a>
			</div>
			{#if r.riskFactors.length > 0}
				<ul class="mt-3 space-y-1">
					{#each r.riskFactors as factor}
						<li class="text-sm text-near-black/70 flex items-start gap-2">
							<span class="text-yellow-600 mt-0.5">⚠</span>{factor}
						</li>
					{/each}
				</ul>
			{:else}
				<p class="mt-3 text-sm text-green-700">All backup signals are healthy.</p>
			{/if}
			{#if data.recentVerifications && data.recentVerifications.length > 0}
				<div class="mt-3 pt-3 border-t border-border space-y-1">
					{#each data.recentVerifications.slice(0, 3) as v}
						<div class="flex items-center justify-between text-xs">
							<span class="font-mono text-near-black/60">{v.filename}</span>
							<span class="flex items-center gap-2">
								<Badge variant={v.status === 'passed' ? 'success' : 'danger'}>{v.type}</Badge>
								<span class="text-near-black/50 tabular-nums">{formatDate(v.completedAt, dateFormat)}</span>
							</span>
						</div>
					{/each}
				</div>
			{/if}
		</Card>
	{/if}

	<div class="grid grid-cols-1 gap-6 lg:grid-cols-2">
		<!-- Recent Invoices -->
		<Card>
			<div class="flex items-center justify-between mb-4">
				<h2 class="text-lg font-semibold text-near-black">{t('dashboard.recentInvoices')}</h2>
				<a href="/invoices" class="text-sm text-cyan hover:text-cyan-dark">{t('dashboard.viewAll')}</a>
			</div>
			{#if data.recentInvoices.length === 0}
				<p class="text-sm text-near-black/60 py-4">{t('dashboard.noInvoices')}</p>
			{:else}
				<div class="space-y-3">
					{#each data.recentInvoices as invoice}
						<a href="/invoices/{invoice.id}" class="flex items-center justify-between py-2 hover:bg-bg/50 rounded px-2 -mx-2">
							<div>
								<p class="text-sm font-medium text-near-black">{invoice.documentId}</p>
								<p class="text-xs text-near-black/60">{invoice.buyer?.name ?? ''}</p>
							</div>
							<div class="text-right">
								<p class="text-sm font-medium tabular-nums">{formatMoney(invoice.totals.total, invoice.currency)}</p>
								<Badge variant={invoiceBadgeVariant(invoice.status)}>{t('status.' + invoice.status)}</Badge>
							</div>
						</a>
					{/each}
				</div>
			{/if}
		</Card>

		<!-- Recent Proposals -->
		<Card>
			<div class="flex items-center justify-between mb-4">
				<h2 class="text-lg font-semibold text-near-black">{t('dashboard.recentProposals')}</h2>
				<a href="/proposals" class="text-sm text-cyan hover:text-cyan-dark">{t('dashboard.viewAll')}</a>
			</div>
			{#if data.recentProposals.length === 0}
				<p class="text-sm text-near-black/60 py-4">{t('empty.noProposalsYet')}</p>
			{:else}
				<div class="space-y-3">
					{#each data.recentProposals as proposal}
						<a href="/proposals/{proposal.id}" class="flex items-center justify-between py-2 hover:bg-bg/50 rounded px-2 -mx-2">
							<div>
								<p class="text-sm font-medium text-near-black">{proposal.documentId}</p>
								<p class="text-xs text-near-black/60">{proposal.buyer?.name ?? ''}</p>
							</div>
							<div class="text-right">
								<p class="text-sm font-medium tabular-nums">{formatMoney(proposal.totals.total, proposal.currency)}</p>
								<Badge variant={proposalBadgeVariant(proposal.status)}>{t('status.' + proposal.status)}</Badge>
							</div>
						</a>
					{/each}
				</div>
			{/if}
		</Card>
	</div>
</div>
