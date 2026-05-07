import { recordCollectorResult, getLatestCollectorResult, listCollectorResults } from '$services/agent-collector-results.js';
import { recordFinding, fingerprintOf } from '$services/agent-findings.js';

export type CisStatus = 'pass' | 'fail' | 'not_applicable' | 'error';
export type CisSeverity = 'low' | 'medium' | 'high';

export interface CisCheckResult {
	checkId: string;
	title: string;
	severity: CisSeverity;
	status: CisStatus;
	message: string;
	evidence: string;
}

export interface CisBenchmarkOutput {
	checkedAt: string;
	platform: string;
	totalChecks: number;
	passedChecks: number;
	failedChecks: number;
	notApplicable: number;
	erroredChecks: number;
	score: number;
	findings: CisCheckResult[];
}

const VALID_STATUS: ReadonlySet<CisStatus> = new Set(['pass', 'fail', 'not_applicable', 'error']);
const VALID_SEVERITY: ReadonlySet<CisSeverity> = new Set(['low', 'medium', 'high']);

function asString(v: unknown, max = 1000): string {
	return typeof v === 'string' ? v.slice(0, max) : '';
}

function asInt(v: unknown): number {
	return typeof v === 'number' && Number.isFinite(v) ? Math.max(0, Math.floor(v)) : 0;
}

function parseFindings(raw: unknown): CisCheckResult[] {
	if (!Array.isArray(raw)) return [];
	const out: CisCheckResult[] = [];
	for (const r of raw) {
		if (!r || typeof r !== 'object') continue;
		const v = r as Record<string, unknown>;
		const status = asString(v.status, 32) as CisStatus;
		const severity = asString(v.severity, 16) as CisSeverity;
		if (!VALID_STATUS.has(status)) continue;
		if (!VALID_SEVERITY.has(severity)) continue;
		const checkId = asString(v.checkId, 64);
		if (!checkId) continue;
		out.push({
			checkId,
			title: asString(v.title, 200),
			severity,
			status,
			message: asString(v.message, 500),
			evidence: asString(v.evidence, 500)
		});
	}
	return out;
}

function parsePayload(raw: Record<string, unknown>): CisBenchmarkOutput | null {
	const findings = parseFindings(raw.findings);
	if (findings.length === 0) return null;
	return {
		checkedAt: asString(raw.checkedAt, 64) || new Date().toISOString(),
		platform: asString(raw.platform, 32) || 'unknown',
		totalChecks: asInt(raw.totalChecks),
		passedChecks: asInt(raw.passedChecks),
		failedChecks: asInt(raw.failedChecks),
		notApplicable: asInt(raw.notApplicable),
		erroredChecks: asInt(raw.erroredChecks),
		score: Math.min(100, asInt(raw.score)),
		findings
	};
}

const SEVERITY_TO_FINDING: Record<CisSeverity, 'low' | 'medium' | 'high'> = {
	low: 'low',
	medium: 'medium',
	high: 'high'
};

export function processCisAuditResult(
	commandId: string,
	agentId: string,
	payload: Record<string, unknown>
): void {
	const parsed = parsePayload(payload);
	if (!parsed) return;
	recordCollectorResult({
		agentId,
		commandId,
		kind: 'cis_audit',
		payload: parsed as unknown as Record<string, unknown>
	});

	for (const f of parsed.findings) {
		if (f.status !== 'fail') continue;
		recordFinding({
			agentId,
			category: 'policy',
			severity: SEVERITY_TO_FINDING[f.severity],
			title: `CIS ${f.checkId}: ${f.title}`,
			evidence: {
				checkId: f.checkId,
				message: f.message,
				evidence: f.evidence,
				platform: parsed.platform,
				checkedAt: parsed.checkedAt
			},
			fingerprint: fingerprintOf('policy', ['cis', agentId, f.checkId])
		});
	}
}

export interface CisView {
	latest: CisBenchmarkOutput | null;
	history: Array<{ checkedAt: string; score: number; failedChecks: number; passedChecks: number; totalChecks: number }>;
}

export function getCisAudit(agentId: string): CisView {
	const latestRow = getLatestCollectorResult(agentId, 'cis_audit');
	const latest = latestRow ? parsePayload(latestRow.payload as Record<string, unknown>) : null;
	const historyRows = listCollectorResults(agentId, 'cis_audit', 30);
	const history: CisView['history'] = [];
	for (const r of historyRows) {
		const p = parsePayload(r.payload as Record<string, unknown>);
		if (!p) continue;
		history.push({
			checkedAt: p.checkedAt,
			score: p.score,
			failedChecks: p.failedChecks,
			passedChecks: p.passedChecks,
			totalChecks: p.totalChecks
		});
	}
	return { latest, history };
}
