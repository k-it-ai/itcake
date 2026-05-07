import { db } from '$lib/server/db.js';
import { computeAggregateScore } from './agent-reliability.js';
import type { FindingCategory, FindingSeverity } from '$lib/types.js';

export interface SecurityPostureComponent {
	key: 'sensitive_data' | 'policy' | 'peripheral' | 'network' | 'filesystem' | 'reliability';
	maxPoints: number;
	earnedPoints: number;
	openCount: number;
	worstSeverity: FindingSeverity | null;
	note: string;
}

export interface SecurityPosture {
	agentId: string;
	score: number;
	riskFactors: string[];
	components: SecurityPostureComponent[];
	computedAt: string;
}

const CATEGORY_WEIGHTS: Record<Exclude<SecurityPostureComponent['key'], 'reliability'>, number> = {
	sensitive_data: 25,
	policy: 20,
	peripheral: 15,
	network: 15,
	filesystem: 10
};
const RELIABILITY_WEIGHT = 15;

const SEVERITY_DEDUCTION_FRACTION: Record<FindingSeverity, number> = {
	critical: 1.0,
	high: 0.8,
	medium: 0.5,
	low: 0.2
};
const SEVERITY_RANK: Record<FindingSeverity, number> = { low: 0, medium: 1, high: 2, critical: 3 };

const stmtCounts = db.prepare(
	`SELECT category, severity, COUNT(*) AS n
	 FROM agent_findings
	 WHERE agent_id = ? AND state = 'open'
	 GROUP BY category, severity`
);

interface CountRow { category: string; severity: string; n: number }

function isSeverity(s: string): s is FindingSeverity {
	return s === 'low' || s === 'medium' || s === 'high' || s === 'critical';
}

function isCategory(c: string): c is FindingCategory {
	return c === 'peripheral' || c === 'sensitive_data' || c === 'network' || c === 'filesystem' || c === 'policy';
}

interface CategoryAggregate { count: number; worst: FindingSeverity | null; deductionFraction: number }

function aggregateCategory(rows: CountRow[], category: FindingCategory): CategoryAggregate {
	let count = 0;
	let worst: FindingSeverity | null = null;
	let maxDeductionFraction = 0;
	for (const r of rows) {
		if (r.category !== category) continue;
		if (!isSeverity(r.severity)) continue;
		count += r.n;
		const d = SEVERITY_DEDUCTION_FRACTION[r.severity];
		if (d > maxDeductionFraction) maxDeductionFraction = d;
		if (worst === null || SEVERITY_RANK[r.severity] > SEVERITY_RANK[worst]) worst = r.severity;
	}
	return { count, worst, deductionFraction: Math.min(1, maxDeductionFraction) };
}

function describeCategory(key: SecurityPostureComponent['key'], agg: CategoryAggregate): string {
	if (agg.count === 0) return 'no open findings';
	const sev = agg.worst ?? 'low';
	const plural = agg.count === 1 ? '' : 's';
	switch (key) {
		case 'sensitive_data': return `${agg.count} open sensitive-data finding${plural} (worst: ${sev})`;
		case 'policy': return `${agg.count} open policy/CIS finding${plural} (worst: ${sev})`;
		case 'peripheral': return `${agg.count} open peripheral finding${plural} (worst: ${sev})`;
		case 'network': return `${agg.count} open network finding${plural} (worst: ${sev})`;
		case 'filesystem': return `${agg.count} open filesystem finding${plural} (worst: ${sev})`;
		default: return '';
	}
}

export function getAgentSecurityPosture(agentId: string): SecurityPosture {
	const raw = stmtCounts.all(agentId) as CountRow[];
	const rows = raw.filter(r => isCategory(r.category) && isSeverity(r.severity));

	const components: SecurityPostureComponent[] = [];
	const riskFactors: string[] = [];
	let score = 0;

	for (const cat of Object.keys(CATEGORY_WEIGHTS) as Array<keyof typeof CATEGORY_WEIGHTS>) {
		const agg = aggregateCategory(rows, cat);
		const max = CATEGORY_WEIGHTS[cat];
		const earned = Math.round(max * (1 - agg.deductionFraction));
		score += earned;
		components.push({
			key: cat,
			maxPoints: max,
			earnedPoints: earned,
			openCount: agg.count,
			worstSeverity: agg.worst,
			note: describeCategory(cat, agg)
		});
		if (earned < max) {
			const lost = max - earned;
			riskFactors.push(`${cat.replace('_', ' ')}: −${lost} pts (${describeCategory(cat, agg)})`);
		}
	}

	const reliability = computeAggregateScore(agentId);
	const reliabilityEarned = Math.round((reliability.score / 100) * RELIABILITY_WEIGHT);
	score += reliabilityEarned;
	components.push({
		key: 'reliability',
		maxPoints: RELIABILITY_WEIGHT,
		earnedPoints: reliabilityEarned,
		openCount: 0,
		worstSeverity: null,
		note: reliability.dailyBuckets.length === 0
			? 'no reliability data yet'
			: `reliability score ${reliability.score}/100 (trend ${reliability.trend})`
	});
	if (reliabilityEarned < RELIABILITY_WEIGHT && reliability.dailyBuckets.length > 0) {
		riskFactors.push(`reliability: ${reliability.score}/100 (trend ${reliability.trend})`);
	} else if (reliability.dailyBuckets.length === 0) {
		riskFactors.push('no reliability data collected yet');
	}

	return {
		agentId,
		score: Math.max(0, Math.min(100, score)),
		riskFactors,
		components,
		computedAt: new Date().toISOString()
	};
}

interface CacheEntry { value: SecurityPosture; expiresAt: number }
const CACHE_TTL_MS = 5 * 60_000;
const cache = new Map<string, CacheEntry>();

export function getAgentSecurityPostureCached(agentId: string): SecurityPosture {
	const now = Date.now();
	const hit = cache.get(agentId);
	if (hit && hit.expiresAt > now) return hit.value;
	const value = getAgentSecurityPosture(agentId);
	cache.set(agentId, { value, expiresAt: now + CACHE_TTL_MS });
	return value;
}

export function invalidateAgentPostureCache(agentId?: string): void {
	if (agentId) cache.delete(agentId);
	else cache.clear();
}

export function _resetPostureCacheForTests(): void {
	cache.clear();
}
