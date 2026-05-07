export interface SsePayload {
	type:
		| 'text_delta'
		| 'tool_use'
		| 'tool_result'
		| 'approval_required'
		| 'error'
		| 'done'
		| 'plan_proposed'
		| 'plan_approved'
		| 'plan_rejected'
		| 'plan_step_auto'
		| 'plan_deviation'
		| 'plan_completed'
		| 'plan_aborted';
	sessionId: string;
	[k: string]: unknown;
}

export type SseEmitter = (payload: SsePayload) => void;

const emitters = new Map<string, SseEmitter>();

export function bindSessionEmitter(sessionId: string, emit: SseEmitter | undefined): () => void {
	if (!emit) return () => undefined;
	emitters.set(sessionId, emit);
	return () => {
		if (emitters.get(sessionId) === emit) emitters.delete(sessionId);
	};
}

export function getSessionEmitter(sessionId: string): SseEmitter | undefined {
	return emitters.get(sessionId);
}
