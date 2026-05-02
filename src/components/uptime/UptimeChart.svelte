<script lang="ts">
	import { t } from '$lib/i18n/index.svelte.js';
	import type { MonitorCheck, MonitorDaily } from '$lib/types.js';

	interface Props {
		monitorId: string;
		lastCheckedAt?: string | null;
	}

	let { monitorId, lastCheckedAt }: Props = $props();

	type Range = '24h' | '7d' | '30d' | '365d';
	let range = $state<Range>('24h');
	let loading = $state(false);
	let granularData = $state<MonitorCheck[]>([]);
	let dailyData = $state<MonitorDaily[]>([]);
	let dataType = $state<'granular' | 'daily'>('granular');
	let tooltip = $state<{ x: number; y: number; text: string } | null>(null);

	const PING_COLOR = '#3b82f6';
	const DOMAIN_COLOR = '#10b981';

	const rangeLabels: Record<Range, string> = {
		'24h': 'uptime.range24h',
		'7d': 'uptime.range7d',
		'30d': 'uptime.range30d',
		'365d': 'uptime.range1y',
	};

	let fetchId = 0;
	let lastFetchedRange = '';

	async function fetchData(r: Range) {
		const id = ++fetchId;
		if (r !== lastFetchedRange) loading = true;
		try {
			const res = await fetch(`/api/monitors/${monitorId}/checks?range=${r}`);
			if (!res.ok || id !== fetchId) return; // stale response guard
			lastFetchedRange = r;
			const json = await res.json();
			dataType = json.type;
			if (json.type === 'granular') {
				granularData = json.data;
				dailyData = [];
			} else {
				dailyData = json.data;
				granularData = [];
			}
		} catch { /* ignore */ }
		if (id === fetchId) loading = false;
	}

	$effect(() => { void lastCheckedAt; fetchData(range); });

	const W = 600;
	const H = 120;
	const PAD = { top: 10, right: 10, bottom: 20, left: 45 };
	const plotW = W - PAD.left - PAD.right;
	const plotH = H - PAD.top - PAD.bottom;

	function isPing(checkType: string) { return checkType === 'ping'; }

	const checkTypeLabel: Record<string, string> = { ping: t('uptime.checkPing'), http: t('uptime.checkHttp'), domain_expiry: t('uptime.checkDomainExpiry'), ssl_expiry: t('uptime.checkSslExpiry') };
	const statusIcon: Record<string, string> = { up: '\u2191', down: '\u2193', error: '!' };

	function formatLocalTime(iso: string): string {
		const d = new Date(iso);
		return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
	}

	let granularSeries = $derived.by(() => {
		if (dataType !== 'granular' || granularData.length === 0) return null;
		const pingChecks = granularData.filter(c => isPing(c.checkType));
		const domainChecks = granularData.filter(c => !isPing(c.checkType));

		const allTimes = granularData.map(c => new Date(c.checkedAt).getTime());
		const minT = Math.min(...allTimes);
		const maxT = Math.max(...allTimes);
		const spanT = maxT - minT || 1;
		const maxRt = Math.max(...granularData.map(c => c.responseTimeMs ?? 0), 1);

		function buildSeries(checks: MonitorCheck[], seriesColor: string, yOffset: number) {
			const sorted = [...checks].sort((a, b) => a.checkedAt.localeCompare(b.checkedAt));
			const lineParts: string[] = [];
			const dots: { cx: number; cy: number; color: string; label: string }[] = [];
			for (const c of sorted) {
				const ct = new Date(c.checkedAt).getTime();
				const x = PAD.left + ((ct - minT) / spanT) * plotW;
				const rt = c.responseTimeMs ?? 0;
				const y = PAD.top + plotH - (rt / maxRt) * plotH + yOffset;
				if (c.responseTimeMs != null) {
					lineParts.push(lineParts.length === 0 ? `M${x},${y}` : `L${x},${y}`);
				}
				const dotColor = c.status === 'up' ? seriesColor : c.status === 'down' ? '#ef4444' : '#eab308';
				const label = `${formatLocalTime(c.checkedAt)} ${checkTypeLabel[c.checkType] ?? c.checkType} ${statusIcon[c.status] ?? c.status}${c.responseTimeMs != null ? ` ${rt}ms` : ''}`;
				dots.push({ cx: x, cy: y, color: dotColor, label });
			}
			return { line: lineParts.join(' '), dots };
		}

		const bothActive = pingChecks.length > 0 && domainChecks.length > 0;
		return {
			ping: buildSeries(pingChecks, PING_COLOR, bothActive ? -3 : 0),
			domain: buildSeries(domainChecks, DOMAIN_COLOR, bothActive ? 3 : 0),
			hasPing: pingChecks.length > 0,
			hasDomain: domainChecks.length > 0,
			maxRt,
		};
	});

	let dailySeries = $derived.by(() => {
		if (dataType !== 'daily' || dailyData.length === 0) return null;
		const pingDaily = dailyData.filter(d => isPing(d.checkType));
		const domainDaily = dailyData.filter(d => !isPing(d.checkType));

		function aggregateByDate(data: MonitorDaily[]) {
			const m = new Map<string, { uptime: number; avgMs: number | null }>();
			for (const d of data) {
				const ex = m.get(d.date);
				if (!ex || d.uptimePercent < ex.uptime) {
					m.set(d.date, { uptime: d.uptimePercent, avgMs: d.avgResponseMs });
				}
			}
			return m;
		}

		const pingByDate = aggregateByDate(pingDaily);
		const domainByDate = aggregateByDate(domainDaily);
		const hasPing = pingByDate.size > 0;
		const hasDomain = domainByDate.size > 0;

		const allDates = [...new Set([...pingByDate.keys(), ...domainByDate.keys()])].sort();
		const n = allDates.length;
		if (n === 0) return { bars: [] as any[], pingLine: '', domainLine: '', hasPing, hasDomain };

		const barW = plotW / n;
		const bars: { x: number; w: number; color: string; label: string; series: 'ping' | 'domain' }[] = [];
		const pingLineParts: string[] = [];
		const domainLineParts: string[] = [];
		const allMs = [...pingByDate.values(), ...domainByDate.values()].map(d => d.avgMs ?? 0);
		const maxMs = Math.max(...allMs, 1);

		for (let i = 0; i < n; i++) {
			const date = allDates[i];
			const x = PAD.left + i * barW;
			const bothPresent = pingByDate.has(date) && domainByDate.has(date);
			const singleW = bothPresent ? (barW - 1) / 2 : barW - 1;
			let offset = 0;

			const pd = pingByDate.get(date);
			if (pd) {
				const col = pd.uptime >= 99.5 ? PING_COLOR : pd.uptime >= 95 ? '#eab308' : '#ef4444';
				bars.push({ x: x + offset, w: singleW, color: col, label: `${date} ${t('uptime.chartPing')}: ${pd.uptime.toFixed(1)}% ${pd.avgMs ?? '—'}ms`, series: 'ping' });
				if (pd.avgMs != null) {
					const lx = x + offset + singleW / 2;
					const ly = PAD.top + plotH - (pd.avgMs / maxMs) * plotH;
					pingLineParts.push(pingLineParts.length === 0 ? `M${lx},${ly}` : `L${lx},${ly}`);
				}
				if (bothPresent) offset += singleW;
			}

			const dd = domainByDate.get(date);
			if (dd) {
				const col = dd.uptime >= 99.5 ? DOMAIN_COLOR : dd.uptime >= 95 ? '#eab308' : '#ef4444';
				bars.push({ x: x + offset, w: singleW, color: col, label: `${date} ${t('uptime.chartDomain')}: ${dd.uptime.toFixed(1)}% ${dd.avgMs ?? '—'}ms`, series: 'domain' });
				if (dd.avgMs != null) {
					const lx = x + offset + singleW / 2;
					const ly = PAD.top + plotH - (dd.avgMs / maxMs) * plotH;
					domainLineParts.push(domainLineParts.length === 0 ? `M${lx},${ly}` : `L${lx},${ly}`);
				}
			}
		}

		return { bars, pingLine: pingLineParts.join(' '), domainLine: domainLineParts.join(' '), hasPing, hasDomain };
	});

	let hasPingData = $derived(
		(dataType === 'granular' ? granularSeries?.hasPing : dailySeries?.hasPing) ?? false
	);
	let hasDomainData = $derived(
		(dataType === 'granular' ? granularSeries?.hasDomain : dailySeries?.hasDomain) ?? false
	);

	function showTip(e: MouseEvent, text: string) {
		tooltip = { x: e.clientX, y: e.clientY - 40, text };
	}
</script>

<div class="space-y-2">
	<!-- Range tabs + legend -->
	<div class="flex items-center gap-2">
		<div class="flex gap-1 flex-1">
			{#each Object.entries(rangeLabels) as [key, labelKey]}
				<button
					class="px-2 py-1 text-xs rounded font-medium transition-colors {range === key ? 'bg-cyan text-white' : 'bg-bg text-near-black/60 hover:text-near-black'}"
					onclick={() => range = key as Range}
				>{t(labelKey)}</button>
			{/each}
		</div>
		{#if hasPingData || hasDomainData}
			<div class="flex gap-3 text-[10px] text-near-black/60">
				{#if hasPingData}
					<span class="flex items-center gap-1"><span class="w-2 h-2 rounded-full" style="background:{PING_COLOR}"></span> {t('uptime.chartPing')}</span>
				{/if}
				{#if hasDomainData}
					<span class="flex items-center gap-1"><span class="w-2 h-2 rounded-full" style="background:{DOMAIN_COLOR}"></span> {t('uptime.chartDomain')}</span>
				{/if}
			</div>
		{/if}
	</div>

	<!-- Chart -->
	<div class="relative rounded-lg border border-border bg-bg-card p-2">
		{#if loading}
			<div class="flex items-center justify-center h-[120px] text-sm text-near-black/60">{t('misc.loading')}</div>
		{:else if (dataType === 'granular' && granularData.length === 0) || (dataType === 'daily' && dailyData.length === 0)}
			<div class="flex items-center justify-center h-[120px] text-sm text-near-black/60">{t('uptime.noData')}</div>
		{:else}
			<svg viewBox="0 0 {W} {H}" class="w-full" preserveAspectRatio="xMidYMid meet" role="img" aria-label={t('aria.uptimeChart')}>
				<!-- Grid lines -->
				<line x1={PAD.left} y1={PAD.top} x2={PAD.left} y2={PAD.top + plotH} stroke="var(--color-border)" stroke-width="0.5" />
				<line x1={PAD.left} y1={PAD.top + plotH} x2={PAD.left + plotW} y2={PAD.top + plotH} stroke="var(--color-border)" stroke-width="0.5" />

				{#if dataType === 'granular' && granularSeries}
					<!-- Ping response time line -->
					{#if granularSeries.ping.line}
						<path d={granularSeries.ping.line} fill="none" stroke={PING_COLOR} stroke-width="1.5" opacity="0.7" />
					{/if}
					<!-- Domain response time line -->
					{#if granularSeries.domain.line}
						<path d={granularSeries.domain.line} fill="none" stroke={DOMAIN_COLOR} stroke-width="1.5" opacity="0.7" />
					{/if}
					<!-- Ping dots -->
					{#each granularSeries.ping.dots as dot}
						<circle cx={dot.cx} cy={dot.cy} r="2" fill={dot.color} class="cursor-pointer" role="graphics-symbol"
							onmouseenter={(e) => showTip(e, dot.label)} onmouseleave={() => tooltip = null} />
					{/each}
					<!-- Domain dots -->
					{#each granularSeries.domain.dots as dot}
						<circle cx={dot.cx} cy={dot.cy} r="2" fill={dot.color} class="cursor-pointer" role="graphics-symbol"
							onmouseenter={(e) => showTip(e, dot.label)} onmouseleave={() => tooltip = null} />
					{/each}
					<!-- Y axis labels -->
					<text x={PAD.left - 5} y={PAD.top + 4} text-anchor="end" font-size="8" fill="var(--color-text-muted, #999)">{granularSeries.maxRt}ms</text>
					<text x={PAD.left - 5} y={PAD.top + plotH} text-anchor="end" font-size="8" fill="var(--color-text-muted, #999)">0</text>
				{:else if dailySeries}
					<!-- Daily bars (ping + domain side by side) -->
					{#each dailySeries.bars as bar}
						<rect
							x={bar.x} y={PAD.top}
							width={bar.w} height={plotH}
							fill={bar.color} opacity="0.3"
							class="cursor-pointer"
							role="graphics-symbol"
							onmouseenter={(e) => showTip(e, bar.label)}
							onmouseleave={() => tooltip = null}
						/>
					{/each}
					<!-- Avg response lines -->
					{#if dailySeries.pingLine}
						<path d={dailySeries.pingLine} fill="none" stroke={PING_COLOR} stroke-width="1.5" opacity="0.8" />
					{/if}
					{#if dailySeries.domainLine}
						<path d={dailySeries.domainLine} fill="none" stroke={DOMAIN_COLOR} stroke-width="1.5" opacity="0.8" />
					{/if}
				{/if}
			</svg>
		{/if}

		{#if tooltip}
			<div
				class="fixed z-50 rounded bg-black px-2 py-1 text-xs text-white whitespace-nowrap pointer-events-none shadow-lg"
				style="left: {tooltip.x}px; top: {tooltip.y}px; transform: translateX(-50%)"
			>{tooltip.text}</div>
		{/if}
	</div>
</div>
