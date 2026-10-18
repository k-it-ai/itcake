<script lang="ts">
	import TopBar from '#lib/components/shell/TopBar.svelte';
	import Btn from '#lib/components/ui/Btn.svelte';
	import Card from '#lib/components/ui/Card.svelte';
	import SectionHead from '#lib/components/ui/SectionHead.svelte';
	import Bar from '#lib/components/ui/Bar.svelte';
	import Tag from '#lib/components/ui/Tag.svelte';
	import { Download } from '#lib/icons/index.js';
	import { formatMoney } from '#lib/money.js';
	import { t } from '#lib/i18n/index.svelte.js';
	import type { PageData } from './$types.js';

	let { data }: { data: PageData } = $props();

	const monthLabels = $derived(Array.from({ length: 12 }, (_, i) => t(`month.${i}`)));
	let activeSection = $state<string>('revenue');

	let maxRevenue = $derived(Math.max(...data.revenue.monthly.map(m => m.revenue), 1));
	let maxTax = $derived(Math.max(...data.tax.monthly.map(m => m.taxCollected), 1));
	let maxExpense = $derived(Math.max(...data.expenses.monthly.map(m => m.amount), 1));
	let maxClientRevenue = $derived(Math.max(...data.clients.clients.map((c) => c.revenue), 1));
	let maxCategory = $derived(Math.max(...data.expenses.byCategory.map(c => c.amount), 1));

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

<TopBar
	title={t('reports.title')}
	breadcrumb={[t('crumb.workspace'), t('reports.title')]}
	sub={`${data.year} · ${data.currency}`}
>
	{#snippet right()}
		<div class="flex items-center gap-1">
			<Btn variant="ghost" size="sm" href="/reports?year={data.year - 1}" ariaLabel="Previous year">←</Btn>
			<span class="num px-2 text-[12.5px] font-medium" style="color:var(--ink)">{data.year}</span>
			{#if data.year < data.currentYear}
				<Btn variant="ghost" size="sm" href="/reports?year={data.year + 1}" ariaLabel="Next year">→</Btn>
			{:else}
				<span class="rounded-md border px-2 py-1.5 text-[12.5px]" style="border-color:var(--line);color:var(--muted);opacity:.5">→</span>
			{/if}
		</div>
		<Btn variant="ghost" size="sm" onclick={exportCsv}>
			{#snippet icon()}<Download size={14} strokeWidth={1.6} />{/snippet}
			{t('report.exportCsv')}
		</Btn>
	{/snippet}
</TopBar>

<div class="p-5 space-y-5">
	<div
		class="sticky top-0 z-10 -mx-5 flex flex-wrap gap-2 border-b px-5 py-2"
		style="background:var(--bg);border-color:var(--line)"
	>
		{#each [['revenue', t('report.tabRevenue')], ['clients', t('report.tabClients')], ['tax', t('report.tabTax')], ['expenses', t('report.tabExpenses')]] as [key, label] (key)}
			<button
				type="button"
				onclick={() => scrollToSection(key)}
				class="rounded-md border px-3 py-1.5 text-[12px] font-medium transition-colors focus-visible:outline-2 focus-visible:outline-[var(--brand)] focus-visible:outline-offset-1"
				style={activeSection === key
					? 'background:var(--brand-soft);border-color:#c8e2ec;color:var(--brand-ink)'
					: 'background:#ffffff;border-color:var(--line);color:var(--ink)'}
			>{label}</button>
		{/each}
	</div>

	<div id="section-revenue" class="space-y-4 scroll-mt-16">
		<h2 class="text-[15px] font-semibold" style="color:var(--ink)">{t('report.tabRevenue')}</h2>

		<div class="grid grid-cols-1 gap-3 sm:grid-cols-3">
			<Card padding={14}>
				<p class="text-[11px]" style="color:var(--muted)">{t('report.totalRevenue')}</p>
				<p class="num mt-1 text-[22px] font-semibold tracking-tight" style="color:var(--brand-ink)">{formatMoney(data.revenue.totalRevenue, data.currency)}</p>
			</Card>
			<Card padding={14}>
				<p class="text-[11px]" style="color:var(--muted)">{t('report.totalTax')}</p>
				<p class="num mt-1 text-[22px] font-semibold tracking-tight" style="color:var(--ink)">{formatMoney(data.revenue.totalTax, data.currency)}</p>
			</Card>
			<Card padding={14}>
				<p class="text-[11px]" style="color:var(--muted)">{t('report.paidInvoices')}</p>
				<p class="num mt-1 text-[22px] font-semibold tracking-tight" style="color:var(--ink)">{data.revenue.totalInvoices}</p>
			</Card>
		</div>

		<Card padding={16}>
			<SectionHead title={t('report.monthlyRevenue', { year: data.year })}>
				{#snippet right()}
					<div class="flex items-center gap-3 text-[10.5px]" style="color:var(--muted)">
						<span class="inline-flex items-center gap-1.5">
							<span class="inline-block" style="width:10px;height:8px;background:var(--brand);border-radius:1px"></span>
							{t('status.paid')}
						</span>
						<span class="inline-flex items-center gap-1.5">
							<span class="inline-block" style="width:10px;height:8px;background:var(--accent);opacity:.55;border-radius:1px"></span>
							{t('dashboard.outstanding')}
						</span>
					</div>
				{/snippet}
			</SectionHead>

			<div role="img" aria-label={t('aria.monthlyRevenueChart', { year: data.year, total: formatMoney(data.revenue.totalRevenue, data.currency) })}>
				<div class="flex gap-1.5" style="height:200px;align-items:flex-end">
					{#each data.revenue.monthly as m, i (i)}
						{@const paidPct = maxRevenue > 0 ? (m.revenue / maxRevenue) * 100 : 0}
						<div class="flex flex-1 flex-col items-stretch justify-end" style="min-width:0">
							<div
								title={formatMoney(m.revenue, data.currency)}
								style="height:{Math.max(paidPct, m.revenue > 0 ? 1 : 0)}%;background:var(--brand);border-radius:2px 2px 0 0;transition:height 200ms ease"
							></div>
						</div>
					{/each}
				</div>
				<div class="mt-2 flex gap-1.5 text-[10px]" style="color:var(--muted)">
					{#each monthLabels as label, i (i)}
						<span class="flex-1 text-center" style="min-width:0">{label}</span>
					{/each}
				</div>
			</div>
		</Card>

		<Card padding={0}>
			<div class="border-b px-4 py-3" style="border-color:var(--line-2)">
				<h3 class="text-[13px] font-semibold" style="color:var(--ink)">{t('report.monthlyBreakdown')}</h3>
			</div>
			<div class="overflow-x-auto">
				<table class="w-full text-[12.5px] num">
					<thead>
						<tr style="border-bottom:1px solid var(--line-2)">
							<th class="px-4 py-2 text-left text-[10.5px] font-medium uppercase tracking-wide" style="color:var(--muted)">{t('report.month')}</th>
							<th class="px-4 py-2 text-right text-[10.5px] font-medium uppercase tracking-wide" style="color:var(--muted)">{t('report.revenue')}</th>
							<th class="px-4 py-2 text-right text-[10.5px] font-medium uppercase tracking-wide" style="color:var(--muted)">{t('report.tax')}</th>
							<th class="px-4 py-2 text-right text-[10.5px] font-medium uppercase tracking-wide" style="color:var(--muted)">{t('report.invoices')}</th>
						</tr>
					</thead>
					<tbody>
						{#each data.revenue.monthly as m, i (i)}
							<tr style="border-top:1px solid var(--line-2)">
								<td class="px-4 py-2" style="color:var(--ink)">{monthLabels[i]} {data.year}</td>
								<td class="px-4 py-2 text-right tabular-nums" style="color:var(--ink)">{formatMoney(m.revenue, data.currency)}</td>
								<td class="px-4 py-2 text-right tabular-nums" style="color:var(--muted)">{formatMoney(m.tax, data.currency)}</td>
								<td class="px-4 py-2 text-right tabular-nums" style="color:var(--muted)">{m.count}</td>
							</tr>
						{/each}
					</tbody>
					<tfoot>
						<tr style="background:#fbfcfd;border-top:2px solid var(--line)">
							<td class="px-4 py-2 font-semibold" style="color:var(--ink)">{t('report.total')}</td>
							<td class="px-4 py-2 text-right tabular-nums font-semibold" style="color:var(--brand-ink)">{formatMoney(data.revenue.totalRevenue, data.currency)}</td>
							<td class="px-4 py-2 text-right tabular-nums font-semibold" style="color:var(--ink)">{formatMoney(data.revenue.totalTax, data.currency)}</td>
							<td class="px-4 py-2 text-right tabular-nums font-semibold" style="color:var(--ink)">{data.revenue.totalInvoices}</td>
						</tr>
					</tfoot>
				</table>
			</div>
		</Card>
	</div>

	<div id="section-clients" class="space-y-4 scroll-mt-16">
		<h2 class="text-[15px] font-semibold" style="color:var(--ink)">{t('report.tabClients')}</h2>
		<Card padding={0}>
			<div class="border-b px-4 py-3" style="border-color:var(--line-2)">
				<h3 class="text-[13px] font-semibold" style="color:var(--ink)">{t('report.revenueByClient', { year: data.year })}</h3>
			</div>
			{#if data.clients.clients.length === 0}
				<p class="px-4 py-8 text-center text-[12px]" style="color:var(--muted)">{t('empty.noPaidInvoices')}</p>
			{:else}
				<div class="divide-y" style="border-color:var(--line-2)">
					{#each data.clients.clients as client, i (client.clientId)}
						{@const pct = maxClientRevenue > 0 ? (client.revenue / maxClientRevenue) * 100 : 0}
						{@const sharePct = data.revenue.totalRevenue > 0 ? ((client.revenue / data.revenue.totalRevenue) * 100).toFixed(1) : '0.0'}
						<div class="flex items-center gap-3 px-4 py-2.5" style="border-color:var(--line-2)">
							<span class="num w-6 text-right text-[11px]" style="color:var(--muted)">{i + 1}</span>
							<a href="/clients/{client.clientId}" class="flex-1 truncate text-[12.5px] font-medium hover:underline" style="color:var(--ink)">{client.clientName}</a>
							<div class="hidden w-32 md:block">
								<Bar pct={pct} tone="brand" />
							</div>
							<span class="num w-12 text-right text-[11.5px]" style="color:var(--muted)">{sharePct}%</span>
							<span class="num w-32 text-right text-[12.5px] font-medium tabular-nums" style="color:var(--ink)">{formatMoney(client.revenue, data.currency)}</span>
							<span class="num w-12 text-right text-[11.5px]" style="color:var(--muted)">{client.invoiceCount}</span>
						</div>
					{/each}
				</div>
			{/if}
		</Card>
	</div>

	<div id="section-tax" class="space-y-4 scroll-mt-16">
		<h2 class="text-[15px] font-semibold" style="color:var(--ink)">{t('report.tabTax')}</h2>
		{#if data.isKleinunternehmer}
			<Card padding={20}>
				<div class="flex items-center gap-3">
					<Tag tone="brand">§19 UStG</Tag>
					<p class="text-[12.5px]" style="color:var(--muted)">{t('report.kuNotice')}</p>
				</div>
			</Card>
		{:else}
			<div class="grid grid-cols-1 gap-3 sm:grid-cols-2">
				<Card padding={14}>
					<p class="text-[11px]" style="color:var(--muted)">{t('report.totalTaxCollected')}</p>
					<p class="num mt-1 text-[22px] font-semibold tracking-tight" style="color:var(--ink)">{formatMoney(data.tax.totalTax, data.currency)}</p>
				</Card>
				<Card padding={14}>
					<p class="text-[11px]" style="color:var(--muted)">{t('report.totalNetRevenue')}</p>
					<p class="num mt-1 text-[22px] font-semibold tracking-tight" style="color:var(--ink)">{formatMoney(data.tax.totalNet, data.currency)}</p>
				</Card>
			</div>

			<Card padding={16}>
				<SectionHead title={t('report.monthlyTax', { year: data.year })} />
				<div role="img" aria-label={t('aria.monthlyTaxChart', { year: data.year })}>
					<div class="flex gap-1.5" style="height:200px;align-items:flex-end">
						{#each data.tax.monthly as m, i (i)}
							{@const pct = maxTax > 0 ? (m.taxCollected / maxTax) * 100 : 0}
							<div class="flex flex-1 flex-col items-stretch justify-end" style="min-width:0">
								<div
									title={formatMoney(m.taxCollected, data.currency)}
									style="height:{Math.max(pct, m.taxCollected > 0 ? 1 : 0)}%;background:var(--accent);opacity:.85;border-radius:2px 2px 0 0;transition:height 200ms ease"
								></div>
							</div>
						{/each}
					</div>
					<div class="mt-2 flex gap-1.5 text-[10px]" style="color:var(--muted)">
						{#each monthLabels as label, i (i)}
							<span class="flex-1 text-center" style="min-width:0">{label}</span>
						{/each}
					</div>
				</div>
			</Card>

			<Card padding={0}>
				<div class="border-b px-4 py-3" style="border-color:var(--line-2)">
					<h3 class="text-[13px] font-semibold" style="color:var(--ink)">{t('report.monthlyTaxBreakdown')}</h3>
				</div>
				<div class="overflow-x-auto">
					<table class="w-full text-[12.5px] num">
						<thead>
							<tr style="border-bottom:1px solid var(--line-2)">
								<th class="px-4 py-2 text-left text-[10.5px] font-medium uppercase tracking-wide" style="color:var(--muted)">{t('report.month')}</th>
								<th class="px-4 py-2 text-right text-[10.5px] font-medium uppercase tracking-wide" style="color:var(--muted)">{t('report.taxCollected')}</th>
								<th class="px-4 py-2 text-right text-[10.5px] font-medium uppercase tracking-wide" style="color:var(--muted)">{t('report.netRevenue')}</th>
							</tr>
						</thead>
						<tbody>
							{#each data.tax.monthly as m, i (i)}
								<tr style="border-top:1px solid var(--line-2)">
									<td class="px-4 py-2" style="color:var(--ink)">{monthLabels[i]} {data.year}</td>
									<td class="px-4 py-2 text-right tabular-nums" style="color:var(--ink)">{formatMoney(m.taxCollected, data.currency)}</td>
									<td class="px-4 py-2 text-right tabular-nums" style="color:var(--ink)">{formatMoney(m.netRevenue, data.currency)}</td>
								</tr>
							{/each}
						</tbody>
						<tfoot>
							<tr style="background:#fbfcfd;border-top:2px solid var(--line)">
								<td class="px-4 py-2 font-semibold" style="color:var(--ink)">{t('report.total')}</td>
								<td class="px-4 py-2 text-right tabular-nums font-semibold" style="color:var(--ink)">{formatMoney(data.tax.totalTax, data.currency)}</td>
								<td class="px-4 py-2 text-right tabular-nums font-semibold" style="color:var(--ink)">{formatMoney(data.tax.totalNet, data.currency)}</td>
							</tr>
						</tfoot>
					</table>
				</div>
			</Card>
		{/if}
	</div>

	<div id="section-expenses" class="space-y-4 scroll-mt-16">
		<h2 class="text-[15px] font-semibold" style="color:var(--ink)">{t('report.tabExpenses')}</h2>
		<div class="grid grid-cols-1 gap-3 sm:grid-cols-3">
			<Card padding={14}>
				<p class="text-[11px]" style="color:var(--muted)">{t('report.totalExpenses')}</p>
				<p class="num mt-1 text-[22px] font-semibold tracking-tight" style="color:var(--bad)">{formatMoney(data.expenses.totalExpenses, data.currency)}</p>
			</Card>
			<Card padding={14}>
				<p class="text-[11px]" style="color:var(--muted)">{t('report.expenseCount')}</p>
				<p class="num mt-1 text-[22px] font-semibold tracking-tight" style="color:var(--ink)">{data.expenses.totalCount}</p>
			</Card>
			<Card padding={14}>
				<p class="text-[11px]" style="color:var(--muted)">{t('report.netProfit')}</p>
				<p class="num mt-1 text-[22px] font-semibold tracking-tight" style="color:{data.tax.totalNet - data.expenses.totalExpenses >= 0 ? 'var(--good)' : 'var(--bad)'}">
					{formatMoney(data.tax.totalNet - data.expenses.totalExpenses, data.currency)}
				</p>
			</Card>
		</div>

		<Card padding={16}>
			<SectionHead title={t('report.monthlyExpenses', { year: data.year })} />
			<div role="img" aria-label={t('aria.monthlyExpensesChart', { year: data.year })}>
				<div class="flex gap-1.5" style="height:200px;align-items:flex-end">
					{#each data.expenses.monthly as m, i (i)}
						{@const pct = maxExpense > 0 ? (m.amount / maxExpense) * 100 : 0}
						<div class="flex flex-1 flex-col items-stretch justify-end" style="min-width:0">
							<div
								title={formatMoney(m.amount, data.currency)}
								style="height:{Math.max(pct, m.amount > 0 ? 1 : 0)}%;background:var(--bad);opacity:.7;border-radius:2px 2px 0 0;transition:height 200ms ease"
							></div>
						</div>
					{/each}
				</div>
				<div class="mt-2 flex gap-1.5 text-[10px]" style="color:var(--muted)">
					{#each monthLabels as label, i (i)}
						<span class="flex-1 text-center" style="min-width:0">{label}</span>
					{/each}
				</div>
			</div>
		</Card>

		{#if data.expenses.byCategory.length > 0}
			<Card padding={0}>
				<div class="border-b px-4 py-3" style="border-color:var(--line-2)">
					<h3 class="text-[13px] font-semibold" style="color:var(--ink)">{t('report.byCategory')}</h3>
				</div>
				<div class="divide-y" style="border-color:var(--line-2)">
					{#each data.expenses.byCategory as cat (cat.category)}
						{@const pct = maxCategory > 0 ? (cat.amount / maxCategory) * 100 : 0}
						{@const sharePct = data.expenses.totalExpenses > 0 ? ((cat.amount / data.expenses.totalExpenses) * 100).toFixed(1) : '0.0'}
						<div class="flex items-center gap-3 px-4 py-2.5" style="border-color:var(--line-2)">
							<span class="flex-1 text-[12.5px] font-medium" style="color:var(--ink)">{categoryLabels[cat.category] ?? cat.category}</span>
							<span class="num text-[11.5px]" style="color:var(--muted)">· {sharePct}%</span>
							<div class="hidden w-32 md:block">
								<Bar pct={pct} tone="bad" />
							</div>
							<span class="num w-32 text-right text-[12.5px] font-medium tabular-nums" style="color:var(--ink)">{formatMoney(cat.amount, data.currency)}</span>
							<span class="num w-12 text-right text-[11.5px]" style="color:var(--muted)">{cat.count}</span>
						</div>
					{/each}
				</div>
			</Card>
		{/if}
	</div>
</div>
