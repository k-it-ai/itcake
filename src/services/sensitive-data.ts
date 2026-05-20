import { z } from 'zod';
import { recordFinding, fingerprintOf } from '$services/agent-findings.js';
import { recordCollectorResult } from '$services/agent-collector-results.js';
import type { FindingSeverity } from '$lib/types.js';


const severityEnum = z.enum(['low', 'medium', 'high', 'critical']);

const SAMPLE_MAX = 64;

export const scopeSchema = z.object({
	paths: z.array(z.string().min(1).max(4096)).min(1).max(64),
	suppressPaths: z.array(z.string().min(1).max(4096)).max(64).default([]),
	suppressPatternIds: z.array(z.string().min(1).max(64)).max(64).default([]),
	maxFileSizeBytes: z.number().int().min(1024).max(104_857_600).default(5_242_880),
	timeoutSeconds: z.number().int().min(5).max(1800).default(120),
	workers: z.number().int().min(1).max(16).default(4)
});

export type SensitiveScanScope = z.infer<typeof scopeSchema>;

const findingItemSchema = z.object({
	path: z.string().min(1).max(4096),
	line: z.number().int().min(0).max(100_000_000).default(0),
	patternId: z.string().min(1).max(64),
	severity: severityEnum.default('high'),
	sample: z.string().max(SAMPLE_MAX * 4).default('')
});

const summarySchema = z.object({
	filesScanned: z.number().int().min(0).default(0),
	bytesScanned: z.number().int().min(0).default(0),
	durationMs: z.number().int().min(0).default(0)
}).partial();

export const sensitiveScanResultSchema = z.object({
	findings: z.array(findingItemSchema).max(5000).default([]),
	summary: summarySchema.default({})
});

export function validateScanScope(input: unknown): SensitiveScanScope {
	return scopeSchema.parse(input);
}

function truncateSample(s: string): string {
	if (s.length <= SAMPLE_MAX) return s;
	return s.slice(0, SAMPLE_MAX);
}

function sanitizeSample(patternId: string, sample: string): string {
	const trimmed = truncateSample(sample);
	switch (patternId) {
		case 'pii_ssn':
		case 'pci_card_number':
			return trimmed.replace(/\d/g, '*');
		case 'credential_aws_access_key':
			return trimmed.length > 4 ? trimmed.slice(0, 4) + '[REDACTED]' : '[REDACTED]';
		case 'credential_private_key':
			return '-----BEGIN PRIVATE KEY----- [REDACTED]';
		case 'credential_secret_assignment': {
			const m = trimmed.match(/^([^=:]*[=:])/);
			return m ? `${m[1]} [REDACTED]` : '[REDACTED]';
		}
		case 'financial_iban':
			return trimmed.length > 4 ? trimmed.slice(0, 4) + '[REDACTED]' : '[REDACTED]';
		case 'pii_email': {
			const at = trimmed.indexOf('@');
			if (at <= 1) return '[REDACTED]';
			return trimmed[0] + '[REDACTED]' + trimmed.slice(at);
		}
		default:
			return trimmed;
	}
}

export function processSensitiveScanResult(
	commandId: string,
	agentId: string,
	payload: Record<string, unknown>
): { findingsRecorded: number } {
	const parsed = sensitiveScanResultSchema.safeParse(payload);
	if (!parsed.success) return { findingsRecorded: 0 };
	const { findings, summary } = parsed.data;

	let n = 0;
	for (const f of findings) {
		const fp = fingerprintOf('sensitive_data', [f.path, f.patternId, f.line]);
		recordFinding({
			agentId,
			category: 'sensitive_data',
			severity: f.severity as FindingSeverity,
			title: `${f.patternId} in ${f.path}`,
			evidence: {
				path: f.path,
				line: f.line,
				patternId: f.patternId,
				sample: sanitizeSample(f.patternId, f.sample)
			},
			fingerprint: fp
		});
		n++;
	}

	recordCollectorResult({
		agentId,
		commandId,
		kind: 'filesystem_analysis',
		payload: {
			summary: summary,
			findingsCount: findings.length,
			recordedAt: new Date().toISOString(),
			kindHint: 'sensitive_data_scan'
		}
	});

	return { findingsRecorded: n };
}
