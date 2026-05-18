/**
 * Defense-in-depth: dispatch_agent_command handler must independently
 * fail-closed on unknown action strings, not rely solely on the
 * guardrails tier table. The set of known actions is derived from the
 * guardrails tier tables so the two views can't drift.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';

describe('dispatch_agent_command: independent unknown-action guard', () => {
	const handlerSrc = readFileSync(path.resolve('src/lib/server/ai/tools/agents.ts'), 'utf-8');
	const guardrailsSrc = readFileSync(path.resolve('src/lib/server/ai/guardrails.ts'), 'utf-8');

	it('guardrails exports DISPATCH_AGENT_COMMAND_ACTIONS derived from tier tables', () => {
		expect(guardrailsSrc).toMatch(/export const DISPATCH_AGENT_COMMAND_ACTIONS/);
		expect(guardrailsSrc).toMatch(/TIER2_ACTIONS\.dispatch_agent_command/);
		expect(guardrailsSrc).toMatch(/TIER3_ACTIONS\.dispatch_agent_command/);
	});

	it('handler imports and uses the canonical set', () => {
		expect(handlerSrc).toMatch(/import\s+\{[^}]*DISPATCH_AGENT_COMMAND_ACTIONS[^}]*\}/);
		expect(handlerSrc).toMatch(/DISPATCH_AGENT_COMMAND_ACTIONS\.has\(/);
		expect(handlerSrc).not.toMatch(/const KNOWN_DISPATCH_ACTIONS/);
	});
});
