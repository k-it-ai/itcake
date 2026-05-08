import { describe, it, expect } from 'vitest';
import type { Change } from '../../src/lib/types.js';
import type { ChangeEntityType, ChangeAction } from '../../src/lib/server/changes.js';
import {
	BACKUP_VALID_ENTITY_TYPES,
	BACKUP_VALID_ACTIONS
} from '../../src/lib/server/backup-allowlists.js';

describe('Change type union parity (lib/types vs server/changes)', () => {
	it('every entity type accepted by the backup allowlist is assignable to Change.entityType', () => {
		for (const v of BACKUP_VALID_ENTITY_TYPES) {
			const sample: Change = {
				id: 'x',
				entityType: v as Change['entityType'],
				entityId: 'y',
				action: 'create',
				diff: {},
				userId: 'u',
				createdAt: '2024-01-01T00:00:00.000Z'
			};
			expect(sample.entityType).toBe(v);
		}
	});

	it('every action accepted by the backup allowlist is assignable to Change.action', () => {
		for (const v of BACKUP_VALID_ACTIONS) {
			const sample: Change = {
				id: 'x',
				entityType: 'invoice',
				entityId: 'y',
				action: v as Change['action'],
				diff: {},
				userId: 'u',
				createdAt: '2024-01-01T00:00:00.000Z'
			};
			expect(sample.action).toBe(v);
		}
	});

	it('Change.entityType is a superset of ChangeEntityType', () => {
		const _entity: ChangeEntityType extends Change['entityType'] ? true : never = true;
		expect(_entity).toBe(true);
	});

	it('Change.action is a superset of ChangeAction', () => {
		const _action: ChangeAction extends Change['action'] ? true : never = true;
		expect(_action).toBe(true);
	});

	it('the unions match exactly (no orphan members on either side)', () => {
		const expectedEntities = new Set([
			'invoice', 'creditNote', 'proposal', 'client', 'expense', 'settings',
			'catalog_item', 'unit', 'template', 'monitor', 'ticket', 'agent',
			'alert_rule', 'remote_session', 'custom_field_def', 'saved_filter',
			'agent_finding', 'ai_session', 'ai_tool_execution'
		]);
		const expectedActions = new Set([
			'create', 'update', 'delete', 'status_change', 'reopen', 'send_email',
			'connect', 'disconnect'
		]);

		expect([...BACKUP_VALID_ENTITY_TYPES].sort()).toEqual([...expectedEntities].sort());
		expect([...BACKUP_VALID_ACTIONS].sort()).toEqual([...expectedActions].sort());
	});
});
