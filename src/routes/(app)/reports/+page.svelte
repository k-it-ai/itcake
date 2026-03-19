<script lang="ts">
	import TopBar from '$components/layout/TopBar.svelte';
	import Card from '$components/ui/Card.svelte';
	import Badge from '$components/ui/Badge.svelte';
	import { formatMoney } from '$lib/money.js';
	import { t } from '$lib/i18n/index.svelte.js';
	import type { PageData } from './$types.js';

	let { data }: { data: PageData } = $props();

	const monthLabels = $derived(Array.from({ length: 12 }, (_, i) => t(`month.${i}`)));
	const sections = ['revenue', 'clients', 'tax', 'expenses'] as const;
	let activeSection = $state<string>('revenue');

	const chartWidth = 700;
	const chartHeight = 200;
	const barGap = 8;
	const barWidth = (chartWidth - barGap * 13) / 12;

	let maxRevenue = $derived(Math.max(...data.revenue.monthly.map(m => m.revenue), 1));
	let maxTax = $derived(Math.max(...data.tax.monthly.map(m => m.taxCollected), 1));
	let maxExpense = $derived(Math.max(...data.expenses.monthly.map(m => m.amount), 1));

	let categoryLabels = $derived<Record<string, string>>({
		office: t('category.office'), travel: t('category.travel'), software: t('category.software'),
		equipment: t('category.equipment'), marketing: t('category.marketing'), professional: t('category.professional'),
		insurance: t('category.insurance'), utilities: t('category.utilities'), other: t('category.other')
	});

	function scrollToSection(id: string) {
		activeSection = id;
		document.getElementById(`section-${id}`)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
	}

	function exportCsv() {
		let csv = '';
		if (activeSection === 'revenue') {
			csv = 'Month,Revenue,Tax,Invoices\n';
			for (const m of data.revenue.monthly) {
				csv += `${m.month},${m.revenue / 100},${m.tax / 100},${m.count}\n`;
			}
		} else if (activeSection === 'clients') {
			csv = 'Client,Revenue,Invoices\n';
			for (const c of data.clients.clients) {
				csv += `"${c.clientName.replace(/"/g, '""')}",${c.revenue / 100},${c.invoiceCount}\n`;
			}
		} else if (activeSection === 'tax') {
			csv = 'Month,Tax Collected,Net Revenue\n';
			for (const m of data.tax.monthly) {
				csv += `${m.month},${m.taxCollected / 100},${m.netRevenue / 100}\n`;
			}
		} else {
			csv = 'Month,Expenses,Count\n';
			for (const m of data.expenses.monthly) {
				csv += `${m.month},${m.amount / 100},${m.count}\n`;
			}
		}

		const blob = new Blob([csv], { type: 'text/csv' });
		const url = URL.createObjectURL(blob);
		const a = document.createElement('a');
		a.href = url;
		a.download = `${activeSection}-report-${data.year}.csv`;
		a.click();
		setTimeout(() => URL.revokeObjectURL(url), 10_000);
	}
</script>

<svelte:head><title>{t('page.reports')} | ITCake</title></svelte:head>

<TopBar title={t('reports.title')}>
	{#snippet children()}
		<div class="flex items-center gap-2">
			<a href="/reports?year={data.year - 1}" class="rounded border border-border px-2 py-1 text-xs hover:bg-bg">&larr;</a>
			<span class="text-sm font-medium tabular-nums">{data.year}</span>
			{#if data.year < data.currentYear}
				<a href="/reports?year={data.year + 1}" class="rounded border border-border px-2 py-1 text-xs hover:bg-bg">&rarr;</a>
			{:else}
				<span class="rounded border border-border px-2 py-1 text-xs text-near-black/25">&rarr;</span>
			{/if}
			<button onclick={exportCsv} class="ml-2 rounded border border-border px-3 py-1 text-xs font-medium hover:bg-bg transition-colors">{t('report.exportCsv')}</button>
		</div>
	{/snippet}
</TopBar>

<div class="p-6 space-y-6">
	<!-- Section navigation (sticky, matches settings page style) -->
	<div class="sticky top-0 z-10 bg-bg border-b border-border -mx-6 px-6 py-2 flex gap-2 flex-wrap">
		{#each [['revenue', t('report.tabRevenue')], ['clients', t('report.tabClients')], ['tax', t('report.tabTax')], ['expenses', t('report.tabExpenses')]] as [key, label]}
			<button
				class="px-3 py-1.5 text-sm rounded-full border transition-colors
					{activeSection === key
						? 'border-cyan bg-cyan/10 text-cyan font-medium'
						: 'border-border text-near-black/60 hover:text-near-black hover:border-near-black/30'}"
				onclick={() => scrollToSection(key)}
			>{label}</button>
		{/each}
	</div>

	<!-- Revenue Section -->
	<div id="section-revenue" class="space-y-6 scroll-mt-12">
		<h2 class="text-xl font-bold text-near-black">{t('report.tabRevenue')}</h2>
		<!-- Summary cards -->
		<div class="grid grid-cols-1 gap-4 sm:grid-cols-3">
			<Card>
				<p class="text-sm text-near-black/60">{t('report.totalRevenue')}</p>
				<p class="mt-1 text-2xl font-bold text-cyan">{formatMoney(data.revenue.totalRevenue, data.currency)}</p>
			</Card>
			<Card>
				<p class="text-sm text-near-black/60">{t('report.totalTax')}</p>
				<p class="mt-1 text-2xl font-bold">{formatMoney(data.revenue.totalTax, data.currency)}</p>
			</Card>
			<Card>
				<p class="text-sm text-near-black/60">{t('report.paidInvoices')}</p>
				<p class="mt-1 text-2xl font-bold">{data.revenue.totalInvoices}</p>
			</Card>
		</div>

		<!-- Monthly chart -->
		<Card>
			<h2 class="text-lg font-semibold mb-4">{t('report.monthlyRevenue', { year: data.year })}</h2>
			<div class="overflow-x-auto">
				<svg viewBox="0 0 {chartWidth} {chartHeight + 30}" class="w-full" style="max-height: 280px;" role="img" aria-label={t('aria.monthlyRevenueChart', { year: data.year, total: formatMoney(data.revenue.totalRevenue, data.currency) })}>
					{#each data.revenue.monthly as m, i}
						{@const barHeight = maxRevenue > 0 ? (m.revenue / maxRevenue) * chartHeight : 0}
						{@const x = barGap + i * (barWidth + barGap)}
						{@const y = chartHeight - barHeight}
						<rect {x} {y} width={barWidth} height={Math.max(barHeight, 1)} rx="3" class="fill-cyan/70 hover:fill-cyan transition-colors" />
						<text x={x + barWidth / 2} y={chartHeight + 16} text-anchor="middle" class="fill-near-black/50" style="font-size: 10px;">{monthLabels[i]}</text>
						{#if m.revenue > 0}
							<text x={x + barWidth / 2} y={y - 4} text-anchor="middle" class="fill-near-black/60" style="font-size: 10px;">{formatMoney(m.revenue, data.currency)}</text>
						{/if}
					{/each}
				</svg>
			</div>
		</Card>

		<!-- Monthly table -->
		<Card>
			<h2 class="text-lg font-semibold mb-4">{t('report.monthlyBreakdown')}</h2>
			<div class="overflow-x-auto">
				<table class="w-full text-sm">
					<thead>
						<tr class="border-b border-border">
							<th class="px-4 py-2 text-left text-near-black/60 font-medium">{t('report.month')}</th>
							<th class="px-4 py-2 text-right text-near-black/60 font-medium">{t('report.revenue')}</th>
							<th class="px-4 py-2 text-right text-near-black/60 font-medium">{t('report.tax')}</th>
							<th class="px-4 py-2 text-right text-near-black/60 font-medium">{t('report.invoices')}</th>
						</tr>
					</thead>
					<tbody>
						{#each data.revenue.monthly as m, i}
							<tr class="border-b border-border last:border-0">
								<td class="px-4 py-2">{monthLabels[i]} {data.year}</td>
								<td class="px-4 py-2 text-right tabular-nums">{formatMoney(m.revenue, data.currency)}</td>
								<td class="px-4 py-2 text-right tabular-nums">{formatMoney(m.tax, data.currency)}</td>
								<td class="px-4 py-2 text-right tabular-nums">{m.count}</td>
							</tr>
						{/each}
					</tbody>
					<tfoot>
						<tr class="border-t-2 border-border font-semibold">
							<td class="px-4 py-2">{t('report.total')}</td>
							<td class="px-4 py-2 text-right tabular-nums">{formatMoney(data.revenue.totalRevenue, data.currency)}</td>
							<td class="px-4 py-2 text-right tabular-nums">{formatMoney(data.revenue.totalTax, data.currency)}</td>
							<td class="px-4 py-2 text-right tabular-nums">{data.revenue.totalInvoices}</td>
						</tr>
					</tfoot>
				</table>
			</div>
		</Card>
	</div>

	<!-- Clients Section -->
	<div id="section-clients" class="space-y-6 scroll-mt-12">
		<h2 class="text-xl font-bold text-near-black">{t('report.tabClients')}</h2>
		<Card>
			<h2 class="text-lg font-semibold mb-4">{t('report.revenueByClient', { year: data.year })}</h2>
			{#if data.clients.clients.length === 0}
				<p class="text-sm text-near-black/60 py-4">{t('empty.noPaidInvoices')}</p>
			{:else}
				<div class="overflow-x-auto">
					<table class="w-full text-sm">
						<thead>
							<tr class="border-b border-border">
								<th class="px-4 py-2 text-left text-near-black/60 font-medium">#</th>
								<th class="px-4 py-2 text-left text-near-black/60 font-medium">{t('report.client')}</th>
								<th class="px-4 py-2 text-right text-near-black/60 font-medium">{t('report.revenue')}</th>
								<th class="px-4 py-2 text-right text-near-black/60 font-medium">{t('report.invoices')}</th>
								<th class="px-4 py-2 text-right text-near-black/60 font-medium">{t('report.share')}</th>
							</tr>
						</thead>
						<tbody>
							{#each data.clients.clients as client, i}
								<tr class="border-b border-border last:border-0">
									<td class="px-4 py-2 text-near-black/50">{i + 1}</td>
									<td class="px-4 py-2 font-medium">
										<a href="/clients/{client.clientId}" class="hover:text-cyan">{client.clientName}</a>
									</td>
									<td class="px-4 py-2 text-right tabular-nums">{formatMoney(client.revenue, data.currency)}</td>
									<td class="px-4 py-2 text-right tabular-nums">{client.invoiceCount}</td>
									<td class="px-4 py-2 text-right tabular-nums">
										{data.revenue.totalRevenue > 0 ? ((client.revenue / data.revenue.totalRevenue) * 100).toFixed(1) : '0.0'}%
									</td>
								</tr>
							{/each}
						</tbody>
					</table>
				</div>
			{/if}
		</Card>
	</div>

	<!-- Tax Section -->
	<div id="section-tax" class="space-y-6 scroll-mt-12">
		<h2 class="text-xl font-bold text-near-black">{t('report.tabTax')}</h2>
		{#if data.isKleinunternehmer}
			<Card>
				<div class="flex items-center gap-3 py-4">
					<Badge variant="info">§19 UStG</Badge>
					<p class="text-sm text-near-black/60">{t('report.kuNotice')}</p>
				</div>
			</Card>
		{:else}
			<div class="grid grid-cols-1 gap-4 sm:grid-cols-2">
				<Card>
					<p class="text-sm text-near-black/60">{t('report.totalTaxCollected')}</p>
					<p class="mt-1 text-2xl font-bold">{formatMoney(data.tax.totalTax, data.currency)}</p>
				</Card>
				<Card>
					<p class="text-sm text-near-black/60">{t('report.totalNetRevenue')}</p>
					<p class="mt-1 text-2xl font-bold">{formatMoney(data.tax.totalNet, data.currency)}</p>
				</Card>
			</div>

			<Card>
				<h2 class="text-lg font-semibold mb-4">{t('report.monthlyTax', { year: data.year })}</h2>
				<div class="overflow-x-auto">
					<svg viewBox="0 0 {chartWidth} {chartHeight + 30}" class="w-full" style="max-height: 280px;" role="img" aria-label={t('aria.monthlyTaxChart', { year: data.year })}>
						{#each data.tax.monthly as m, i}
							{@const barHeight = maxTax > 0 ? (m.taxCollected / maxTax) * chartHeight : 0}
							{@const x = barGap + i * (barWidth + barGap)}
							{@const y = chartHeight - barHeight}
							<rect {x} {y} width={barWidth} height={Math.max(barHeight, 1)} rx="3" class="fill-red/50 hover:fill-red/70 transition-colors" />
							<text x={x + barWidth / 2} y={chartHeight + 16} text-anchor="middle" class="fill-near-black/50" style="font-size: 10px;">{monthLabels[i]}</text>
							{#if m.taxCollected > 0}
								<text x={x + barWidth / 2} y={y - 4} text-anchor="middle" class="fill-near-black/60" style="font-size: 10px;">{formatMoney(m.taxCollected, data.currency)}</text>
							{/if}
						{/each}
					</svg>
				</div>
			</Card>

			<Card>
				<h2 class="text-lg font-semibold mb-4">{t('report.monthlyTaxBreakdown')}</h2>
				<div class="overflow-x-auto">
					<table class="w-full text-sm">
						<thead>
							<tr class="border-b border-border">
								<th class="px-4 py-2 text-left text-near-black/60 font-medium">{t('report.month')}</th>
								<th class="px-4 py-2 text-right text-near-black/60 font-medium">{t('report.taxCollected')}</th>
								<th class="px-4 py-2 text-right text-near-black/60 font-medium">{t('report.netRevenue')}</th>
							</tr>
						</thead>
						<tbody>
							{#each data.tax.monthly as m, i}
								<tr class="border-b border-border last:border-0">
									<td class="px-4 py-2">{monthLabels[i]} {data.year}</td>
									<td class="px-4 py-2 text-right tabular-nums">{formatMoney(m.taxCollected, data.currency)}</td>
									<td class="px-4 py-2 text-right tabular-nums">{formatMoney(m.netRevenue, data.currency)}</td>
								</tr>
							{/each}
						</tbody>
						<tfoot>
							<tr class="border-t-2 border-border font-semibold">
								<td class="px-4 py-2">{t('report.total')}</td>
								<td class="px-4 py-2 text-right tabular-nums">{formatMoney(data.tax.totalTax, data.currency)}</td>
								<td class="px-4 py-2 text-right tabular-nums">{formatMoney(data.tax.totalNet, data.currency)}</td>
							</tr>
						</tfoot>
					</table>
				</div>
			</Card>
		{/if}
	</div>

	<!-- Expenses Section -->
	<div id="section-expenses" class="space-y-6 scroll-mt-12">
		<h2 class="text-xl font-bold text-near-black">{t('report.tabExpenses')}</h2>
		<div class="grid grid-cols-1 gap-4 sm:grid-cols-3">
			<Card>
				<p class="text-sm text-near-black/60">{t('report.totalExpenses')}</p>
				<p class="mt-1 text-2xl font-bold text-red">{formatMoney(data.expenses.totalExpenses, data.currency)}</p>
			</Card>
			<Card>
				<p class="text-sm text-near-black/60">{t('report.expenseCount')}</p>
				<p class="mt-1 text-2xl font-bold">{data.expenses.totalCount}</p>
			</Card>
			<Card>
				<p class="text-sm text-near-black/60">{t('report.netProfit')}</p>
				<p class="mt-1 text-2xl font-bold {data.tax.totalNet - data.expenses.totalExpenses >= 0 ? 'text-cyan' : 'text-red'}">
					{formatMoney(data.tax.totalNet - data.expenses.totalExpenses, data.currency)}
				</p>
			</Card>
		</div>

		<Card>
			<h2 class="text-lg font-semibold mb-4">{t('report.monthlyExpenses', { year: data.year })}</h2>
			<div class="overflow-x-auto">
				<svg viewBox="0 0 {chartWidth} {chartHeight + 30}" class="w-full" style="max-height: 280px;" role="img" aria-label={t('aria.monthlyExpensesChart', { year: data.year })}>
					{#each data.expenses.monthly as m, i}
						{@const barHeight = maxExpense > 0 ? (m.amount / maxExpense) * chartHeight : 0}
						{@const x = barGap + i * (barWidth + barGap)}
						{@const y = chartHeight - barHeight}
						<rect {x} {y} width={barWidth} height={Math.max(barHeight, 1)} rx="3" class="fill-red/50 hover:fill-red/70 transition-colors" />
						<text x={x + barWidth / 2} y={chartHeight + 16} text-anchor="middle" class="fill-near-black/50" style="font-size: 10px;">{monthLabels[i]}</text>
						{#if m.amount > 0}
							<text x={x + barWidth / 2} y={y - 4} text-anchor="middle" class="fill-near-black/60" style="font-size: 10px;">{formatMoney(m.amount, data.currency)}</text>
						{/if}
					{/each}
				</svg>
			</div>
		</Card>

		{#if data.expenses.byCategory.length > 0}
			<Card>
				<h2 class="text-lg font-semibold mb-4">{t('report.byCategory')}</h2>
				<div class="overflow-x-auto">
					<table class="w-full text-sm">
						<thead>
							<tr class="border-b border-border">
								<th class="px-4 py-2 text-left text-near-black/60 font-medium">{t('report.category')}</th>
								<th class="px-4 py-2 text-right text-near-black/60 font-medium">{t('report.amount')}</th>
								<th class="px-4 py-2 text-right text-near-black/60 font-medium">{t('report.count')}</th>
								<th class="px-4 py-2 text-right text-near-black/60 font-medium">{t('report.share')}</th>
							</tr>
						</thead>
						<tbody>
							{#each data.expenses.byCategory as cat}
								<tr class="border-b border-border last:border-0">
									<td class="px-4 py-2">{categoryLabels[cat.category] ?? cat.category}</td>
									<td class="px-4 py-2 text-right tabular-nums">{formatMoney(cat.amount, data.currency)}</td>
									<td class="px-4 py-2 text-right tabular-nums">{cat.count}</td>
									<td class="px-4 py-2 text-right tabular-nums">
										{data.expenses.totalExpenses > 0 ? ((cat.amount / data.expenses.totalExpenses) * 100).toFixed(1) : '0.0'}%
									</td>
								</tr>
							{/each}
						</tbody>
					</table>
				</div>
			</Card>
		{/if}
	</div>
</div>
