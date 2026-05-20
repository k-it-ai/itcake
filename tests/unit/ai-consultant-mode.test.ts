/**
 * Consultant mode is the default AI posture: the model is read-only.
 * Tier 2+ tools must be both:
 *   - hidden from the model in getToolDefinitionsForMode (so the model
 *     doesn't waste tokens constructing dispatch calls), AND
 *   - hard-blocked at the guardrail (the actual security boundary —
 *     the listing filter is a UX improvement, not a defence).
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { existsSync, mkdirSync, rmSync } from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';

const TEST_DIR = path.resolve('data-test-ai-consultant');

let checkGuardrails: typeof import('../../src/lib/server/ai/guardrails.js').checkGuardrails;
let TOOL_TIERS: typeof import('../../src/lib/server/ai/guardrails.js').TOOL_TIERS;
let getToolDefinitionsForMode: typeof import('../../src/lib/server/ai/tool-registry.js').getToolDefinitionsForMode;

beforeAll(async () => {
	if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
	mkdirSync(TEST_DIR, { recursive: true });
	process.env.DATABASE_PATH = path.join(TEST_DIR, 'ai.db');
	process.env.DATA_DIR = TEST_DIR;
	process.env.SESSION_SECRET ||= randomBytes(32).toString('hex');
	const g = await import('../../src/lib/server/ai/guardrails.js');
	checkGuardrails = g.checkGuardrails;
	TOOL_TIERS = g.TOOL_TIERS;
	// Side-effect import: registers tools so getToolDefinitionsForMode has something to return.
	await import('../../src/lib/server/ai/tools/index.js');
	const tr = await import('../../src/lib/server/ai/tool-registry.js');
	getToolDefinitionsForMode = tr.getToolDefinitionsForMode;
});

describe('AI consultant mode', () => {
	it('hard-blocks dispatch_agent_command regardless of action when consultantMode is true', () => {
		const r = checkGuardrails('dispatch_agent_command',
			{ agentId: 'a-1', action: 'shell', command: 'ls' },
			'auto_approve_safe',
			{ consultantMode: true });
		expect(r.allowed).toBe(false);
		expect(r.tier).toBe(4);
		expect(r.reason).toContain('consultant mode');
	});

	it('hard-blocks even the safest dispatch action (system_info_refresh) when consultantMode is true', () => {
		const r = checkGuardrails('dispatch_agent_command',
			{ agentId: 'a-1', action: 'system_info_refresh' },
			'auto_approve_safe',
			{ consultantMode: true });
		expect(r.allowed).toBe(false);
	});

	it('blocks tier-2 plan + backup tools when consultantMode is true', () => {
		for (const name of ['propose_action_plan', 'verify_backup_integrity', 'run_backup_test_restore'] as const) {
			const r = checkGuardrails(name, {}, 'auto_approve_safe', { consultantMode: true });
			expect(r.allowed, `${name} should be blocked in consultant mode`).toBe(false);
		}
	});

	it('still allows every tier-1 tool in consultant mode', () => {
		const tier1 = Object.entries(TOOL_TIERS).filter(([, tier]) => tier === 1).map(([name]) => name);
		expect(tier1.length).toBeGreaterThan(0);
		for (const name of tier1) {
			const r = checkGuardrails(name, {}, 'per_step', { consultantMode: true });
			expect(r.allowed, `${name} should be allowed`).toBe(true);
			expect(r.requiresApproval, `${name} should not require approval`).toBe(false);
		}
	});

	it('full mode (consultantMode false) preserves the original tier semantics', () => {
		const r = checkGuardrails('dispatch_agent_command',
			{ agentId: 'a-1', action: 'shell', command: 'ls' },
			'auto_approve_safe',
			{ consultantMode: false });
		expect(r.allowed).toBe(true);
		expect(r.tier).toBe(3);
		expect(r.requiresApproval).toBe(true);
	});

	it('getToolDefinitionsForMode returns only tier-1 tools in consultant mode', () => {
		const all = getToolDefinitionsForMode({ consultantMode: false });
		const consultant = getToolDefinitionsForMode({ consultantMode: true });
		expect(consultant.length).toBeLessThan(all.length);
		const tier1Names = new Set(
			Object.entries(TOOL_TIERS).filter(([, tier]) => tier === 1).map(([n]) => n)
		);
		for (const def of consultant) {
			expect(tier1Names.has(def.name), `tool ${def.name} should be tier-1`).toBe(true);
		}
		// Both new ticket tools must be present in consultant mode.
		const names = new Set(consultant.map(d => d.name));
		expect(names.has('list_tickets')).toBe(true);
		expect(names.has('get_ticket')).toBe(true);
		expect(names.has('propose_ticket_response')).toBe(true);
		// And dispatch is hidden.
		expect(names.has('dispatch_agent_command')).toBe(false);
	});
});

describe('ticket tools (consultant mode primary surface)', () => {
	let getTool: typeof import('../../src/lib/server/ai/tool-registry.js').getTool;
	let db: typeof import('../../src/lib/server/db.js').db;

	beforeAll(async () => {
		const tr = await import('../../src/lib/server/ai/tool-registry.js');
		getTool = tr.getTool;
		const dbMod = await import('../../src/lib/server/db.js');
		db = dbMod.db;
		// Seed a client + a ticket so the read tools have something to return.
		db.prepare("INSERT OR REPLACE INTO documents (id, type, data) VALUES ('c-1', 'client', ?)").run(
			JSON.stringify({ id: 'c-1', name: 'Acme Co', email: 'ops@acme.test' })
		);
		db.prepare("INSERT OR REPLACE INTO documents (id, type, data) VALUES ('t-1', 'ticket', ?)").run(
			JSON.stringify({
				id: 't-1', ticketNumber: 'T-001', title: 'Printer offline',
				clientId: 'c-1', date: '2026-05-01', startTime: '09:00', hours: 1, hourlyRate: 9000,
				status: 'open', invoiceId: null, notes: '', description: '<p>The printer keeps going offline.</p>',
				createdAt: '2026-05-01T09:00:00Z', updatedAt: '2026-05-01T09:00:00Z'
			})
		);
	});

	it('list_tickets returns the seeded ticket', async () => {
		const tool = getTool('list_tickets');
		expect(tool).toBeDefined();
		const out = await tool!.handler({ status: 'open' }, { userId: 'u-1', sessionId: 's-1' }) as { tickets: { ticketNumber: string }[] };
		expect(out.tickets.find(t => t.ticketNumber === 'T-001')).toBeDefined();
	});

	it('get_ticket returns sanitised description + client', async () => {
		const tool = getTool('get_ticket');
		const out = await tool!.handler({ id: 't-1' }, { userId: 'u-1', sessionId: 's-1' }) as { client: { name: string }; description: string };
		expect(out.client.name).toBe('Acme Co');
		expect(out.description).toBe('The printer keeps going offline.');
	});

	it('propose_ticket_response NEVER writes to the DB — it only returns a proposal envelope', async () => {
		const tool = getTool('propose_ticket_response');
		const before = (db.prepare("SELECT data FROM documents WHERE id = 't-1'").get() as { data: string }).data;
		const out = await tool!.handler({
			ticketId: 't-1',
			resolution: 'Try power-cycling the printer and confirming DHCP lease.',
			rationale: 'Most common cause of intermittent offline status.',
			suggestedStatus: 'completed'
		}, { userId: 'u-1', sessionId: 's-1' }) as { kind: string; ticketId: string };
		expect(out.kind).toBe('proposal');
		expect(out.ticketId).toBe('t-1');
		const after = (db.prepare("SELECT data FROM documents WHERE id = 't-1'").get() as { data: string }).data;
		expect(after).toBe(before);
	});

	it('propose_ticket_response refuses unknown tickets', async () => {
		const tool = getTool('propose_ticket_response');
		await expect(tool!.handler(
			{ ticketId: 'does-not-exist', resolution: 'noop' },
			{ userId: 'u-1', sessionId: 's-1' }
		)).rejects.toThrow(/not found/);
	});
});
