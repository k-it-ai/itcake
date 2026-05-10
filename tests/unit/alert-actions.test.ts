import { describe, it, expect, beforeAll, vi } from 'vitest';
import { mkdirSync, rmSync, existsSync } from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { createAlertRuleSchema } from '../../src/lib/validators-rmm.js';

const TEST_DIR = path.resolve('data-test-alert-actions');

let runAlertActions: typeof import('../../src/services/alerts.js').runAlertActions;
let dispatchCommandModule: typeof import('../../src/services/agent-commands.js');

beforeAll(async () => {
	if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
	mkdirSync(TEST_DIR, { recursive: true });
	mkdirSync(path.join(TEST_DIR, 'backups'), { recursive: true });
	mkdirSync(path.join(TEST_DIR, 'uploads'), { recursive: true });
	process.env.DATABASE_PATH = path.join(TEST_DIR, 'alerts.db');
	process.env.DATA_DIR = TEST_DIR;
	process.env.SESSION_SECRET ||= randomBytes(32).toString('hex');

	const alerts = await import('../../src/services/alerts.js');
	dispatchCommandModule = await import('../../src/services/agent-commands.js');
	runAlertActions = alerts.runAlertActions;
});

describe('createAlertRuleSchema accepts the actions array', () => {
	it('accepts notify + service_action + wait', () => {
		const r = createAlertRuleSchema.safeParse({
			name: 'docker fell over',
			condition: { kind: 'agent_offline', durationMinutes: 5 },
			actions: [
				{ type: 'notify' },
				{ type: 'service_action', agentId: 'a-1', service: 'docker', action: 'restart' },
				{ type: 'wait', seconds: 10 },
				{ type: 'shell', agentId: 'a-1', command: 'docker ps' }
			]
		});
		expect(r.success).toBe(true);
	});

	it('rejects unknown action type', () => {
		const r = createAlertRuleSchema.safeParse({
			name: 'x',
			condition: { kind: 'agent_reboot_required' },
			actions: [{ type: 'made_up' as 'notify', x: 1 }]
		});
		expect(r.success).toBe(false);
	});

	it('rejects malformed service name', () => {
		const r = createAlertRuleSchema.safeParse({
			name: 'x',
			condition: { kind: 'agent_reboot_required' },
			actions: [{ type: 'service_action', agentId: 'a-1', service: '../etc/passwd', action: 'restart' }]
		});
		expect(r.success).toBe(false);
	});

	it('caps actions array at 20', () => {
		const r = createAlertRuleSchema.safeParse({
			name: 'x',
			condition: { kind: 'agent_reboot_required' },
			actions: Array(21).fill({ type: 'notify' })
		});
		expect(r.success).toBe(false);
	});

	it('caps wait seconds', () => {
		const r = createAlertRuleSchema.safeParse({
			name: 'x',
			condition: { kind: 'agent_reboot_required' },
			actions: [{ type: 'wait', seconds: 99999 }]
		});
		expect(r.success).toBe(false);
	});
});

describe('runAlertActions interpreter', () => {
	const baseRule = {
		id: 'rule-1', name: 'r', enabled: true,
		scope: 'agent_reboot_required' as const,
		condition: { kind: 'agent_reboot_required' as const },
		cooldownMinutes: 60, channels: [] as ('telegram' | 'email')[],
		lastFiredAt: null, userId: 'u-1',
		createdAt: '2026-01-01 00:00:00', updatedAt: '2026-01-01 00:00:00'
	};
	const baseHit = { subject: 's', bodyText: 'b', bodyHtml: '<b>b</b>' };

	it('dispatches commands for shell + service_action', async () => {
		const spy = vi.spyOn(dispatchCommandModule, 'dispatchCommand').mockImplementation(() => ({} as never));
		await runAlertActions({
			...baseRule,
			actions: [
				{ type: 'shell', agentId: 'a-1', command: 'echo hi' },
				{ type: 'service_action', agentId: 'a-1', service: 'docker', action: 'restart' }
			]
		}, baseHit, 'u-1');
		expect(spy).toHaveBeenCalledTimes(2);
		expect(spy.mock.calls[0][1]).toBe('shell');
		expect(spy.mock.calls[1][1]).toBe('service_action');
		spy.mockRestore();
	});

	it('halts on failure with onFailure: stop (default)', async () => {
		const spy = vi.spyOn(dispatchCommandModule, 'dispatchCommand')
			.mockImplementationOnce(() => { throw new Error('agent not found'); })
			.mockImplementation(() => ({} as never));
		await runAlertActions({
			...baseRule,
			actions: [
				{ type: 'shell', agentId: 'a-bad', command: 'fail' },
				{ type: 'shell', agentId: 'a-good', command: 'should-not-run' }
			]
		}, baseHit, 'u-1');
		expect(spy).toHaveBeenCalledTimes(1);
		spy.mockRestore();
	});

	it('continues past failure with onFailure: continue', async () => {
		const spy = vi.spyOn(dispatchCommandModule, 'dispatchCommand')
			.mockImplementationOnce(() => { throw new Error('agent not found'); })
			.mockImplementation(() => ({} as never));
		await runAlertActions({
			...baseRule,
			actions: [
				{ type: 'shell', agentId: 'a-bad', command: 'fail', onFailure: 'continue' },
				{ type: 'shell', agentId: 'a-good', command: 'should-run' }
			]
		}, baseHit, 'u-1');
		expect(spy).toHaveBeenCalledTimes(2);
		spy.mockRestore();
	});

	it('wait blocks for the requested duration', async () => {
		vi.useFakeTimers();
		try {
			const promise = runAlertActions({
				...baseRule,
				actions: [{ type: 'wait', seconds: 1 }]
			}, baseHit, 'u-1');
			let resolved = false;
			void promise.then(() => { resolved = true; });
			await vi.advanceTimersByTimeAsync(900);
			expect(resolved).toBe(false);
			await vi.advanceTimersByTimeAsync(101);
			await promise;
			expect(resolved).toBe(true);
		} finally {
			vi.useRealTimers();
		}
	});

	it('halts the chain when validateCommandPayload rejects (default onFailure stop)', async () => {
		const spy = vi.spyOn(dispatchCommandModule, 'dispatchCommand').mockImplementation(() => ({} as never));
		await runAlertActions({
			...baseRule,
			actions: [
				{ type: 'service_action', agentId: 'a-1', service: '../etc/passwd', action: 'restart' } as never,
				{ type: 'shell', agentId: 'a-1', command: 'echo never-reached' }
			]
		}, baseHit, 'u-1');
		expect(spy).not.toHaveBeenCalled();
		spy.mockRestore();
	});

	it('continues past payload-rejection when onFailure=continue, still skipping the dispatch', async () => {
		const spy = vi.spyOn(dispatchCommandModule, 'dispatchCommand').mockImplementation(() => ({} as never));
		await runAlertActions({
			...baseRule,
			actions: [
				{ type: 'shell', agentId: 'a-1', command: '', onFailure: 'continue' } as never,
				{ type: 'shell', agentId: 'a-1', command: 'echo ok' }
			]
		}, baseHit, 'u-1');
		expect(spy).toHaveBeenCalledTimes(1);
		expect((spy.mock.calls[0][2] as { command: string }).command).toBe('echo ok');
		spy.mockRestore();
	});
});
