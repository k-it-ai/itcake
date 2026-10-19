import { recordCollectorResult, listCollectorResults } from '#services/agent-collector-results.js';
import type { AgentCollectorResult } from '#lib/types.js';


export interface ReliabilityDailyPayload {
	day: string;
	uptimeSeconds: number;
	crashes: number;
	hangs: number;
	serviceFailures: number;
	hardwareErrors: number;
}

export interface ReliabilityScoreInput {
	uptimeSeconds: number;
	crashes: number;
	hangs: number;
	serviceFailures: number;
	hardwareErrors: number;
}

export interface AggregateReliability {
	score: number;
	trend: 'up' | 'flat' | 'down';
	confidence: number;
	mtbfHours: number | null;
	dailyBuckets: ReliabilityDailyPayload[];
}

const SECONDS_PER_DAY = 86400;
const TREND_WINDOW_DAYS = 30;
const MTBF_WINDOW_DAYS = 90;

const RELIABILITY_FACTOR_WEIGHTS = {
	uptime: 30,
	crashes: 25,
	hangs: 15,
	serviceFailures: 15,
	hardwareErrors: 15
} as const;

function clampScore(value: number): number {
	if (!Number.isFinite(value)) return 0;
	return Math.max(0, Math.min(100, Math.round(value)));
}

function coerceCount(value: unknown): number {
	if (typeof value !== 'number' || !Number.isFinite(value)) return 0;
	return Math.max(0, Math.floor(value));
}

function coerceUptime(value: unknown): number {
	if (typeof value !== 'number' || !Number.isFinite(value)) return 0;
	return Math.max(0, Math.min(SECONDS_PER_DAY, value));
}

function isDayKey(value: unknown): value is string {
	return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value);
}

function parsePayload(payload: Record<string, unknown>): ReliabilityDailyPayload | null {
	if (!isDayKey(payload.day)) return null;
	return {
		day: payload.day,
		uptimeSeconds: coerceUptime(payload.uptimeSeconds),
		crashes: coerceCount(payload.crashes),
		hangs: coerceCount(payload.hangs),
		serviceFailures: coerceCount(payload.serviceFailures),
		hardwareErrors: coerceCount(payload.hardwareErrors)
	};
}

export function computeScore(input: ReliabilityScoreInput): number {
	const uptimeFraction = Math.max(0, Math.min(1, input.uptimeSeconds / SECONDS_PER_DAY));
	const uptimeScore = clampScore(uptimeFraction * 100);
	const crashScore = clampScore(100 - input.crashes * 20);
	const hangScore = clampScore(100 - input.hangs * 10);
	const serviceScore = clampScore(100 - input.serviceFailures * 15);
	const hardwareScore = clampScore(100 - input.hardwareErrors * 25);

	const weighted =
		(uptimeScore * RELIABILITY_FACTOR_WEIGHTS.uptime +
			crashScore * RELIABILITY_FACTOR_WEIGHTS.crashes +
			hangScore * RELIABILITY_FACTOR_WEIGHTS.hangs +
			serviceScore * RELIABILITY_FACTOR_WEIGHTS.serviceFailures +
			hardwareScore * RELIABILITY_FACTOR_WEIGHTS.hardwareErrors) / 100;

	return clampScore(weighted);
}

interface RegressionResult {
	slope: number;
	r2: number;
}

function linearRegression(points: Array<{ x: number; y: number }>): RegressionResult {
	const n = points.length;
	if (n < 2) return { slope: 0, r2: 0 };
	let xMean = 0;
	let yMean = 0;
	for (const p of points) { xMean += p.x; yMean += p.y; }
	xMean /= n;
	yMean /= n;
	let num = 0;
	let den = 0;
	for (const p of points) {
		const dx = p.x - xMean;
		num += dx * (p.y - yMean);
		den += dx * dx;
	}
	if (den === 0) return { slope: 0, r2: 0 };
	const slope = num / den;
	const intercept = yMean - slope * xMean;
	let ssRes = 0;
	let ssTot = 0;
	for (const p of points) {
		const predicted = slope * p.x + intercept;
		ssRes += (p.y - predicted) ** 2;
		ssTot += (p.y - yMean) ** 2;
	}
	const r2 = ssTot === 0 ? 0 : Math.max(0, Math.min(1, 1 - (ssRes / ssTot)));
	return { slope, r2 };
}

export function computeTrend(scores: number[]): { trend: 'up' | 'flat' | 'down'; confidence: number } {
	if (scores.length < 2) return { trend: 'flat', confidence: 0 };
	const points = scores.map((y, x) => ({ x, y }));
	const { slope, r2 } = linearRegression(points);
	const coverage = Math.min(1, scores.length / TREND_WINDOW_DAYS);
	const confidence = Math.max(0, Math.min(1, r2 * coverage));
	let trend: 'up' | 'flat' | 'down' = 'flat';
	if (slope > 0.2) trend = 'up';
	else if (slope < -0.2) trend = 'down';
	return { trend, confidence };
}

export function computeMtbf(input: {
	crashes: number;
	hangs: number;
	serviceFailures: number;
	hardwareErrors: number;
	uptimeHours: number;
}): number | null {
	const failures = input.crashes + input.hangs + input.serviceFailures + input.hardwareErrors;
	if (failures <= 0) return null;
	if (input.uptimeHours <= 0) return 0;
	return input.uptimeHours / failures;
}

function rowsToBuckets(rows: AgentCollectorResult[]): ReliabilityDailyPayload[] {
	const byDay = new Map<string, ReliabilityDailyPayload>();
	for (const row of rows) {
		const parsed = parsePayload(row.payload);
		if (!parsed) continue;
		if (!byDay.has(parsed.day)) byDay.set(parsed.day, parsed);
	}
	return Array.from(byDay.values()).sort((a, b) => a.day.localeCompare(b.day));
}

export function processReliabilityResult(
	commandId: string,
	agentId: string,
	payload: Record<string, unknown>
): void {
	const parsed = parsePayload(payload);
	if (!parsed) return;
	recordCollectorResult({
		agentId,
		commandId,
		kind: 'reliability_daily',
		payload: parsed as unknown as Record<string, unknown>
	});
}

export function computeAggregateScore(agentId: string): AggregateReliability {
	const rows = listCollectorResults(agentId, 'reliability_daily', 500);
	const all = rowsToBuckets(rows);
	const trendBuckets = all.slice(-TREND_WINDOW_DAYS);
	const mtbfBuckets = all.slice(-MTBF_WINDOW_DAYS);

	if (trendBuckets.length === 0) {
		return { score: 0, trend: 'flat', confidence: 0, mtbfHours: null, dailyBuckets: [] };
	}

	const dailyScores = trendBuckets.map(b => computeScore(b));
	const score = dailyScores[dailyScores.length - 1] ?? 0;
	const { trend, confidence } = computeTrend(dailyScores);

	let crashes = 0, hangs = 0, serviceFailures = 0, hardwareErrors = 0, uptime = 0;
	for (const b of mtbfBuckets) {
		crashes += b.crashes;
		hangs += b.hangs;
		serviceFailures += b.serviceFailures;
		hardwareErrors += b.hardwareErrors;
		uptime += b.uptimeSeconds;
	}
	const mtbfHours = computeMtbf({
		crashes, hangs, serviceFailures, hardwareErrors,
		uptimeHours: uptime / 3600
	});

	return {
		score,
		trend,
		confidence: Math.round(confidence * 100) / 100,
		mtbfHours: mtbfHours === null ? null : Math.round(mtbfHours * 10) / 10,
		dailyBuckets: trendBuckets
	};
}
