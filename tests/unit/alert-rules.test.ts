import { describe, it, expect } from 'vitest';
import {
	createAlertRuleSchema,
	updateAlertRuleSchema,
	bulkDispatchSchema,
	setAgentTagsSchema,
	alertScopeFor
} from '../../src/lib/validators-rmm.js';

describe('createAlertRuleSchema', () => {
	it('accepts a metric_threshold rule', () => {
		const r = createAlertRuleSchema.safeParse({
			name: 'High CPU',
			condition: { kind: 'metric_threshold', metric: 'cpu', op: '>', value: 90 }
		});
		expect(r.success).toBe(true);
		if (r.success) expect(r.data.condition.kind).toBe('metric_threshold');
	});

	it('accepts an agent_offline rule with tagAny filter', () => {
		const r = createAlertRuleSchema.safeParse({
			name: 'Prod offline',
			condition: { kind: 'agent_offline', durationMinutes: 10, tagAny: ['prod'] },
			channels: ['telegram']
		});
		expect(r.success).toBe(true);
	});

	it('rejects unknown condition.kind', () => {
		const r = createAlertRuleSchema.safeParse({
			name: 'x', condition: { kind: 'made_up', value: 1 }
		});
		expect(r.success).toBe(false);
	});

	it('rejects metric_threshold with out-of-range value', () => {
		const r = createAlertRuleSchema.safeParse({
			name: 'x', condition: { kind: 'metric_threshold', metric: 'cpu', op: '>', value: 150 }
		});
		expect(r.success).toBe(false);
	});

	it('rejects empty channels list', () => {
		const r = createAlertRuleSchema.safeParse({
			name: 'x',
			condition: { kind: 'agent_reboot_required' },
			channels: []
		});
		expect(r.success).toBe(false);
	});

	it('clamps cooldownMinutes within bounds via schema', () => {
		const r = createAlertRuleSchema.safeParse({
			name: 'x', condition: { kind: 'agent_reboot_required' }, cooldownMinutes: 0
		});
		expect(r.success).toBe(false);
	});

	it('rejects empty name', () => {
		const r = createAlertRuleSchema.safeParse({
			name: '', condition: { kind: 'agent_reboot_required' }
		});
		expect(r.success).toBe(false);
	});

	it('updateAlertRuleSchema accepts partial input', () => {
		const r = updateAlertRuleSchema.safeParse({ enabled: false });
		expect(r.success).toBe(true);
	});
});

describe('alertScopeFor', () => {
	it('maps each condition kind to a scope', () => {
		expect(alertScopeFor('metric_threshold')).toBe('agent_metric');
		expect(alertScopeFor('agent_offline')).toBe('agent_offline');
		expect(alertScopeFor('agent_reboot_required')).toBe('agent_reboot_required');
		expect(alertScopeFor('monitor_status')).toBe('monitor_status');
	});

	it('throws for unknown kind', () => {
		expect(() => alertScopeFor('nonsense')).toThrow();
	});
});

describe('setAgentTagsSchema', () => {
	it('accepts a normal set of tags', () => {
		const r = setAgentTagsSchema.safeParse({ tags: ['prod', 'web', 'us-east'] });
		expect(r.success).toBe(true);
	});

	it('rejects uppercase tags', () => {
		const r = setAgentTagsSchema.safeParse({ tags: ['Prod'] });
		expect(r.success).toBe(false);
	});

	it('rejects tags starting with non-alphanumeric', () => {
		const r = setAgentTagsSchema.safeParse({ tags: ['-prefix'] });
		expect(r.success).toBe(false);
	});

	it('rejects > 30 tags', () => {
		const r = setAgentTagsSchema.safeParse({ tags: Array(31).fill('a') });
		expect(r.success).toBe(false);
	});

	it('rejects tag length > 50', () => {
		const r = setAgentTagsSchema.safeParse({ tags: ['a'.repeat(51)] });
		expect(r.success).toBe(false);
	});
});

describe('bulkDispatchSchema', () => {
	it('rejects when both tagAny and tagAll are empty', () => {
		const r = bulkDispatchSchema.safeParse({
			tagAny: [], tagAll: [], type: 'shell', payload: { command: 'echo hi' }
		});
		expect(r.success).toBe(false);
	});

	it('accepts tagAny only', () => {
		const r = bulkDispatchSchema.safeParse({
			tagAny: ['prod'], type: 'shell', payload: { command: 'uptime' }
		});
		expect(r.success).toBe(true);
	});

	it('accepts tagAll only', () => {
		const r = bulkDispatchSchema.safeParse({
			tagAll: ['linux', 'prod'], type: 'system_info_refresh', payload: {}
		});
		expect(r.success).toBe(true);
	});

	it('rejects shell without command', () => {
		const r = bulkDispatchSchema.safeParse({
			tagAny: ['prod'], type: 'shell', payload: {}
		});
		expect(r.success).toBe(false);
	});
});
