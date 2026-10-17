import type { ApprovalMode, AiSettings } from '#lib/types.js';

// Re-exports of cross-tier domain types so server-side code can import the
// AI surface from one place. Canonical definitions live in lib/types.ts.
export type { ApprovalMode, AiSettings };

export type AiToolExecutionStatus = 'pending' | 'approved' | 'rejected' | 'auto' | 'completed' | 'failed' | 'expired';

export interface AiToolExecution {
	id: string;
	sessionId: string;
	messageId: string | null;
	toolName: string;
	toolInput: Record<string, unknown>;
	tier: 1 | 2 | 3 | 4;
	status: AiToolExecutionStatus;
	approvalDescription: string | null;
	approvedBy: string | null;
	approvedAt: string | null;
	resultSummary: string | null;
	durationMs: number | null;
	errorMessage: string | null;
	createdAt: string;
	completedAt: string | null;
}
