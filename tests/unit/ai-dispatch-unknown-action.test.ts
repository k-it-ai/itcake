/**
 * Defense-in-depth: dispatch_agent_command handler must independently
 * fail-closed on unknown action strings, not rely solely on the
 * guardrails tier table. A future refactor that bypasses checkGuardrails
 * (tests, internal dispatch) could otherwise reach validateCommandPayload
 * with an unmodelled action.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';

describe('dispatch_agent_command: independent unknown-action guard', () => {
	const src = readFileSync(path.resolve('src/lib/server/ai/tools/agents.ts'), 'utf-8');

	it('declares KNOWN_DISPATCH_ACTIONS', () => {
		expect(src).toMatch(/const KNOWN_DISPATCH_ACTIONS\s*=\s*new Set/);
	});

	it('handler checks KNOWN_DISPATCH_ACTIONS before dispatch', () => {
		// The check must appear inside the dispatch_agent_command handler,
		// before validateCommandPayload + dispatchCommand. We pin order via
		// substring positions.
		const handler = src.slice(src.indexOf("registerTool('dispatch_agent_command'"));
		const knownIdx = handler.indexOf('KNOWN_DISPATCH_ACTIONS.has');
		const validateIdx = handler.indexOf('validateCommandPayload');
		const dispatchIdx = handler.indexOf('dispatchCommand(');
		expect(knownIdx).toBeGreaterThan(0);
		expect(validateIdx).toBeGreaterThan(knownIdx);
		expect(dispatchIdx).toBeGreaterThan(validateIdx);
	});
});
