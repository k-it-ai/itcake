/**
 * Resume safety: `loadAnthropicMessages` injects synthetic `tool_result`
 * blocks for any assistant `tool_use` that has no paired user
 * `tool_result` in the transcript. Without this, a crash between
 * persisting the assistant turn and persisting the tool result leaves
 * the session permanently un-postable — Anthropic's SDK rejects the
 * dangling-tool_use shape with a 400.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { mkdirSync, rmSync, existsSync } from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';

const TEST_DIR = path.resolve('data-test-ai-session-resume');

let db: typeof import('../../src/lib/server/db.js').db;
let _loadAnthropicMessagesForTests: typeof import('../../src/services/ai-session.js')._loadAnthropicMessagesForTests;

beforeAll(async () => {
	if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
	mkdirSync(TEST_DIR, { recursive: true });
	process.env.DATABASE_PATH = path.join(TEST_DIR, 'aires.db');
	process.env.DATA_DIR = TEST_DIR;
	process.env.SESSION_SECRET ||= randomBytes(32).toString('hex');

	db = (await import('../../src/lib/server/db.js')).db;
	_loadAnthropicMessagesForTests = (await import('../../src/services/ai-session.js'))._loadAnthropicMessagesForTests;

	// Minimum scaffolding for the FK.
	db.prepare(`INSERT INTO users (id, email, password_hash) VALUES (?, ?, ?)`).run('u', 'u@t', 'h');
});

function makeSession(id: string) {
	db.prepare(
		`INSERT INTO ai_sessions (id, user_id, title, model, status, turn_count, plan_steps) VALUES (?, ?, ?, 'claude-opus-4-7', 'active', 0, NULL)`
	).run(id, 'u', 't');
}

function insertMsg(id: string, sessionId: string, role: 'user' | 'assistant', blocks: unknown) {
	db.prepare(
		`INSERT INTO ai_messages (id, session_id, role, content_blocks) VALUES (?, ?, ?, ?)`
	).run(id, sessionId, role, JSON.stringify(blocks));
}

describe('loadAnthropicMessages — resume safety (synthetic tool_result on dangling tool_use)', () => {
	it('clean transcript (paired tool_use + tool_result) is unchanged', () => {
		const sid = 's-clean';
		makeSession(sid);
		insertMsg(`${sid}-m1`, sid, 'user', [{ type: 'text', text: 'check agent a-1' }]);
		insertMsg(`${sid}-m2`, sid, 'assistant', [{ type: 'tool_use', id: 'toolu_1', name: 'get_agent', input: { id: 'a-1' } }]);
		insertMsg(`${sid}-m3`, sid, 'user', [{ type: 'tool_result', tool_use_id: 'toolu_1', content: 'ok' }]);
		insertMsg(`${sid}-m4`, sid, 'assistant', [{ type: 'text', text: 'done' }]);

		const out = _loadAnthropicMessagesForTests(sid);
		expect(out).toHaveLength(4);
		expect(out[3]).toMatchObject({ role: 'assistant' });
	});

	it('dangling tool_use gets a synthetic aborted tool_result appended', () => {
		const sid = 's-dangling';
		makeSession(sid);
		insertMsg(`${sid}-m1`, sid, 'user', [{ type: 'text', text: 'list agents' }]);
		insertMsg(`${sid}-m2`, sid, 'assistant', [
			{ type: 'tool_use', id: 'toolu_X', name: 'list_agents', input: {} }
		]);
		// No matching tool_result — process crashed before persisting.

		const out = _loadAnthropicMessagesForTests(sid);
		expect(out).toHaveLength(3);
		const synthetic = out[2];
		expect(synthetic.role).toBe('user');
		expect(synthetic.content).toEqual([
			{ type: 'tool_result', tool_use_id: 'toolu_X', content: 'aborted by process restart', is_error: true }
		]);
	});

	it('multiple dangling tool_use ids in one assistant turn all get synthetic results', () => {
		const sid = 's-multi-dangling';
		makeSession(sid);
		insertMsg(`${sid}-m1`, sid, 'user', [{ type: 'text', text: 'do all three' }]);
		insertMsg(`${sid}-m2`, sid, 'assistant', [
			{ type: 'tool_use', id: 'toolu_A', name: 'list_agents', input: {} },
			{ type: 'tool_use', id: 'toolu_B', name: 'get_agent', input: { id: 'a' } },
			{ type: 'tool_use', id: 'toolu_C', name: 'list_tickets', input: {} }
		]);

		const out = _loadAnthropicMessagesForTests(sid);
		expect(out).toHaveLength(3);
		const synthetic = out[2].content as Array<{ type: string; tool_use_id: string }>;
		expect(synthetic).toHaveLength(3);
		const ids = synthetic.map(b => b.tool_use_id).sort();
		expect(ids).toEqual(['toolu_A', 'toolu_B', 'toolu_C']);
	});

	it('partially paired turn — only the dangling one gets a synthetic result', () => {
		const sid = 's-partial';
		makeSession(sid);
		insertMsg(`${sid}-m1`, sid, 'user', [{ type: 'text', text: 'two tools' }]);
		insertMsg(`${sid}-m2`, sid, 'assistant', [
			{ type: 'tool_use', id: 'toolu_paired', name: 'list_agents', input: {} },
			{ type: 'tool_use', id: 'toolu_dangling', name: 'get_agent', input: { id: 'a' } }
		]);
		insertMsg(`${sid}-m3`, sid, 'user', [
			{ type: 'tool_result', tool_use_id: 'toolu_paired', content: 'ok' }
			// toolu_dangling missing
		]);

		const out = _loadAnthropicMessagesForTests(sid);
		expect(out).toHaveLength(4);
		const synthetic = out[3].content as Array<{ type: string; tool_use_id: string }>;
		expect(synthetic).toHaveLength(1);
		expect(synthetic[0].tool_use_id).toBe('toolu_dangling');
	});

	it('rowid ordering preserves tool_use → tool_result even in same-second writes', () => {
		const sid = 's-rowid';
		makeSession(sid);
		// Insert in proper logical order; UUIDs are random but rowid is monotonic.
		insertMsg('zzzz-first', sid, 'user', [{ type: 'text', text: 'go' }]);
		insertMsg('aaaa-second', sid, 'assistant', [
			{ type: 'tool_use', id: 'toolu_R', name: 'list_agents', input: {} }
		]);
		insertMsg('mmmm-third', sid, 'user', [
			{ type: 'tool_result', tool_use_id: 'toolu_R', content: 'ok' }
		]);

		const out = _loadAnthropicMessagesForTests(sid);
		expect(out).toHaveLength(3);
		const blocks2 = out[1].content as Array<{ type: string }>;
		expect(blocks2[0].type).toBe('tool_use');
		const blocks3 = out[2].content as Array<{ type: string }>;
		expect(blocks3[0].type).toBe('tool_result');
	});
});
