export type ApprovalMode = 'per_step' | 'auto_approve_safe' | 'plan';

export type AiToolExecutionStatus = 'pending' | 'approved' | 'rejected' | 'auto' | 'completed' | 'failed' | 'expired';

export interface AiSettings {
	enabled: boolean;
	apiKey: string;
	model: string;
	monthlyBudgetCents: number;
	approvalMode: ApprovalMode;
	maxTurnsPerSession: number;
	maxOutputTokensPerTurn: number;
	thinkingMode: 'adaptive' | 'disabled';
}

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
