import { z } from 'zod';
import { recordCollectorResult, getLatestCollectorResult } from '$services/agent-collector-results.js';
import { recordFinding, fingerprintOf, listFindingsByCategory } from '$services/agent-findings.js';

const CLEANUP_CATEGORY_VALUES = ['temp_files', 'browser_cache', 'package_cache', 'trash', 'old_downloads'] as const;
const ALL_CATEGORY_VALUES = [...CLEANUP_CATEGORY_VALUES, 'unrotated_logs'] as const;

const FINDING_THRESHOLD_BYTES = 5 * 1024 * 1024 * 1024;

export const filesystemScopeSchema = z.object({
	paths: z.array(z.string().min(1).max(4096)).min(1).max(64),
	skipPatterns: z.array(z.string().min(1).max(1000)).max(64).default([]),
	maxFileSizeBytes: z.number().int().min(1).max(100 * 1024 * 1024 * 1024).default(5 * 1024 * 1024 * 1024),
	timeoutSeconds: z.number().int().min(5).max(3600).default(600),
	workers: z.number().int().min(1).max(16).default(4)
});

export type FilesystemScope = z.infer<typeof filesystemScopeSchema>;

export function validateFilesystemScope(input: unknown): FilesystemScope {
	return filesystemScopeSchema.parse(input);
}

export const filesystemCleanupSchema = z.object({
	category: z.enum(CLEANUP_CATEGORY_VALUES),
	paths: z.array(
		z.string().min(1).max(4096).refine(s => s.startsWith('/') || /^[A-Za-z]:[\\/]/.test(s), 'paths must be absolute')
	).min(1).max(1000)
});

const fileEntrySchema = z.object({
	path: z.string().max(4096),
	sizeBytes: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
	modTime: z.string().max(100).default('')
});

const dirEntrySchema = z.object({
	path: z.string().max(4096),
	totalBytes: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
	fileCount: z.number().int().min(0)
});

const categoryReportSchema = z.object({
	id: z.enum(ALL_CATEGORY_VALUES),
	totalBytes: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
	fileCount: z.number().int().min(0),
	samples: z.array(fileEntrySchema).max(50).default([])
});

export const filesystemAnalysisResultSchema = z.object({
	scannedAt: z.string().max(100).default(''),
	durationSeconds: z.number().int().min(0).default(0),
	filesScanned: z.number().int().min(0).default(0),
	bytesScanned: z.number().int().min(0).default(0),
	directoriesScanned: z.number().int().min(0).default(0),
	categories: z.array(categoryReportSchema).max(20).default([]),
	topFiles: z.array(fileEntrySchema).max(100).default([]),
	topDirectories: z.array(dirEntrySchema).max(100).default([]),
	truncated: z.boolean().default(false),
	errors: z.array(z.string().max(2000)).max(100).default([])
});

export const filesystemCleanupResultSchema = z.object({
	deleted: z.number().int().min(0).default(0),
	skipped: z.number().int().min(0).default(0),
	freedBytes: z.number().int().min(0).default(0),
	errors: z.array(z.string().max(2000)).max(200).default([])
});

export function processFilesystemAnalysisResult(
	commandId: string,
	agentId: string,
	payload: Record<string, unknown>
): { categoriesRecorded: number; findingsEmitted: number } {
	const parsed = filesystemAnalysisResultSchema.safeParse(payload);
	if (!parsed.success) return { categoriesRecorded: 0, findingsEmitted: 0 };
	const data = parsed.data;

	recordCollectorResult({
		agentId,
		commandId,
		kind: 'filesystem_analysis',
		payload: {
			scannedAt: data.scannedAt,
			durationSeconds: data.durationSeconds,
			filesScanned: data.filesScanned,
			bytesScanned: data.bytesScanned,
			directoriesScanned: data.directoriesScanned,
			categories: data.categories,
			topFiles: data.topFiles,
			topDirectories: data.topDirectories,
			truncated: data.truncated,
			errors: data.errors,
			recordedAt: new Date().toISOString()
		}
	});

	let findingsEmitted = 0;
	for (const cat of data.categories) {
		if (cat.totalBytes < FINDING_THRESHOLD_BYTES) continue;
		const fp = fingerprintOf('filesystem', [agentId, cat.id]);
		recordFinding({
			agentId,
			category: 'filesystem',
			severity: 'low',
			title: `Large ${cat.id} cleanup opportunity`,
			evidence: {
				categoryId: cat.id,
				totalBytes: cat.totalBytes,
				fileCount: cat.fileCount,
				sampleCount: cat.samples.length
			},
			fingerprint: fp
		});
		findingsEmitted++;
	}

	return { categoriesRecorded: data.categories.length, findingsEmitted };
}

export function processFilesystemCleanupResult(
	commandId: string,
	agentId: string,
	payload: Record<string, unknown>
): { deleted: number; freedBytes: number } {
	const parsed = filesystemCleanupResultSchema.safeParse(payload);
	if (!parsed.success) return { deleted: 0, freedBytes: 0 };
	const data = parsed.data;
	recordCollectorResult({
		agentId,
		commandId,
		kind: 'filesystem_analysis',
		payload: {
			kindHint: 'filesystem_cleanup',
			deleted: data.deleted,
			skipped: data.skipped,
			freedBytes: data.freedBytes,
			errors: data.errors,
			recordedAt: new Date().toISOString()
		}
	});
	return { deleted: data.deleted, freedBytes: data.freedBytes };
}

export function getFilesystemSnapshot(agentId: string): {
	latestAnalysis: ReturnType<typeof getLatestCollectorResult>;
	findings: ReturnType<typeof listFindingsByCategory>;
} {
	return {
		latestAnalysis: getLatestCollectorResult(agentId, 'filesystem_analysis'),
		findings: listFindingsByCategory(agentId, 'filesystem', 100)
	};
}
