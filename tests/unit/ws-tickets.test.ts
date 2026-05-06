import { describe, it, expect, afterEach } from 'vitest';
import { issueTicket, consumeTicket, _resetTicketsForTests, _ticketCountForTests } from '../../src/lib/server/ws-tickets.js';

afterEach(() => _resetTicketsForTests());

describe('issueTicket / consumeTicket', () => {
	it('issues and consumes once', () => {
		const t = issueTicket('ai_stream', { sessionId: 'sess-1' }, 5000);
		expect(t.token.length).toBeGreaterThan(20);
		expect(t.scope).toBe('ai_stream');
		const got = consumeTicket<{ sessionId: string }>(t.token, 'ai_stream');
		expect(got).toEqual({ sessionId: 'sess-1' });
		expect(consumeTicket(t.token, 'ai_stream')).toBeNull();
	});

	it('rejects wrong scope', () => {
		const t = issueTicket('dashboard', { x: 1 }, 5000);
		expect(consumeTicket(t.token, 'ai_stream')).toBeNull();
		// wrong-scope consumption ALSO burns the ticket — leaking it would
		// give the caller a way to enumerate scopes.
		expect(consumeTicket(t.token, 'dashboard')).toBeNull();
	});

	it('rejects expired tickets', async () => {
		const t = issueTicket('test_short', { x: 1 }, 1000);
		await new Promise(r => setTimeout(r, 1100));
		expect(consumeTicket(t.token, 'test_short')).toBeNull();
	});

	it('rejects malformed scope on issue', () => {
		expect(() => issueTicket('ALL_CAPS', {}, 5000)).toThrow();
		expect(() => issueTicket('a', {}, 5000)).toThrow(); // too short
		expect(() => issueTicket('with space', {}, 5000)).toThrow();
		expect(() => issueTicket('with/slash', {}, 5000)).toThrow();
	});

	it('rejects out-of-range ttl on issue', () => {
		expect(() => issueTicket('ok_scope', {}, 500)).toThrow();
		expect(() => issueTicket('ok_scope', {}, 60 * 60_000)).toThrow();
	});

	it('non-existent token returns null without throwing', () => {
		expect(consumeTicket('definitely-not-issued', 'ai_stream')).toBeNull();
	});

	it('issued tickets accumulate; consumed ones drop', () => {
		const a = issueTicket('a_scope', {}, 5000);
		const b = issueTicket('b_scope', {}, 5000);
		expect(_ticketCountForTests()).toBe(2);
		consumeTicket(a.token, 'a_scope');
		expect(_ticketCountForTests()).toBe(1);
		consumeTicket(b.token, 'b_scope');
		expect(_ticketCountForTests()).toBe(0);
	});
});
