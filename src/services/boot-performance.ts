import { recordCollectorResult, listCollectorResults, getLatestCollectorResult } from '#services/agent-collector-results.js';
import { recordFinding, fingerprintOf } from '#services/agent-findings.js';

export interface BootPerformancePayload {
	bootTimestamp: string;
	biosSeconds: number;
	osLoaderSeconds: number;
	desktopReadySeconds: number;
	totalBootSeconds: number;
	startupItemCount: number;
	source: string;
}

export interface BootPerformanceTrend {
	latest: BootPerformancePayload | null;
	history: BootPerformancePayload[];
	medianTotalSeconds: number | null;
	p95TotalSeconds: number | null;
	slowBootCount: number;
}

const SLOW_BOOT_THRESHOLD_SECONDS = 90;
const HISTORY_LIMIT = 30;

function coerceSeconds(value: unknown, fallback = 0): number {
	if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) return fallback;
	return Math.min(7200, value);
}

function coerceCount(value: unknown): number {
	if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) return 0;
	return Math.min(10000, Math.floor(value));
}

function coerceTimestamp(value: unknown): string | null {
	if (typeof value !== 'string') return null;
	const t = Date.parse(value);
	if (!Number.isFinite(t)) return null;
	return new Date(t).toISOString();
}

function parsePayload(raw: Record<string, unknown>): BootPerformancePayload | null {
	const ts = coerceTimestamp(raw.bootTimestamp);
	if (!ts) return null;
	return {
		bootTimestamp: ts,
		biosSeconds: coerceSeconds(raw.biosSeconds),
		osLoaderSeconds: coerceSeconds(raw.osLoaderSeconds),
		desktopReadySeconds: coerceSeconds(raw.desktopReadySeconds),
		totalBootSeconds: coerceSeconds(raw.totalBootSeconds),
		startupItemCount: coerceCount(raw.startupItemCount),
		source: typeof raw.source === 'string' ? raw.source.slice(0, 64) : ''
	};
}

function rowsToPayloads(rows: { payload: Record<string, unknown> }[]): BootPerformancePayload[] {
	const out: BootPerformancePayload[] = [];
	for (const r of rows) {
		const p = parsePayload(r.payload);
		if (p) out.push(p);
	}
	return out;
}

export function processBootPerformanceResult(
	commandId: string,
	agentId: string,
	payload: Record<string, unknown>
): void {
	const parsed = parsePayload(payload);
	if (!parsed) return;

	const existing = listCollectorResults(agentId, 'boot_performance', HISTORY_LIMIT);
	for (const r of existing) {
		const t = coerceTimestamp((r.payload as { bootTimestamp?: unknown }).bootTimestamp);
		if (t === parsed.bootTimestamp) return;
	}

	recordCollectorResult({
		agentId,
		commandId,
		kind: 'boot_performance',
		payload: parsed as unknown as Record<string, unknown>
	});

	if (parsed.totalBootSeconds > SLOW_BOOT_THRESHOLD_SECONDS) {
		recordFinding({
			agentId,
			category: 'policy',
			severity: parsed.totalBootSeconds > 180 ? 'medium' : 'low',
			title: `Slow boot: ${parsed.totalBootSeconds.toFixed(1)}s`,
			evidence: {
				bootTimestamp: parsed.bootTimestamp,
				totalBootSeconds: parsed.totalBootSeconds,
				biosSeconds: parsed.biosSeconds,
				osLoaderSeconds: parsed.osLoaderSeconds,
				desktopReadySeconds: parsed.desktopReadySeconds,
				startupItemCount: parsed.startupItemCount,
				thresholdSeconds: SLOW_BOOT_THRESHOLD_SECONDS
			},
			fingerprint: fingerprintOf('policy', ['slow-boot', agentId, parsed.bootTimestamp])
		});
	}
}

function median(values: number[]): number | null {
	if (values.length === 0) return null;
	const sorted = [...values].sort((a, b) => a - b);
	const mid = Math.floor(sorted.length / 2);
	return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

function percentile(values: number[], p: number): number | null {
	if (values.length === 0) return null;
	const sorted = [...values].sort((a, b) => a - b);
	const idx = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length));
	return sorted[idx];
}

export function getBootPerformanceTrend(agentId: string): BootPerformanceTrend {
	const rows = listCollectorResults(agentId, 'boot_performance', HISTORY_LIMIT);
	const history = rowsToPayloads(rows);
	if (history.length === 0) {
		return { latest: null, history: [], medianTotalSeconds: null, p95TotalSeconds: null, slowBootCount: 0 };
	}
	const totals = history.map(h => h.totalBootSeconds).filter(t => t > 0);
	return {
		latest: history[0],
		history,
		medianTotalSeconds: median(totals),
		p95TotalSeconds: percentile(totals, 95),
		slowBootCount: totals.filter(t => t > SLOW_BOOT_THRESHOLD_SECONDS).length
	};
}

export function getLatestBootPerformance(agentId: string): BootPerformancePayload | null {
	const r = getLatestCollectorResult(agentId, 'boot_performance');
	if (!r) return null;
	return parsePayload(r.payload);
}
