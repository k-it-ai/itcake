import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { mkdirSync, rmSync, existsSync } from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';

const TEST_DIR = path.resolve('data-test-collector-query');
const AGENT = 'a-cq';

let queryCollectorResults: typeof import('../../src/services/collector-query.js').queryCollectorResults;
let recordCollectorResult: typeof import('../../src/services/agent-collector-results.js').recordCollectorResult;
let listCollectorTables: typeof import('../../src/lib/server/collector-tables.js').listCollectorTables;
let db: typeof import('../../src/lib/server/db.js').db;

beforeAll(async () => {
	if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
	mkdirSync(TEST_DIR, { recursive: true });
	process.env.DATABASE_PATH = path.join(TEST_DIR, 'cq.db');
	process.env.DATA_DIR = TEST_DIR;
	process.env.SESSION_SECRET ||= randomBytes(32).toString('hex');

	const cq = await import('../../src/services/collector-query.js');
	const cr = await import('../../src/services/agent-collector-results.js');
	const ct = await import('../../src/lib/server/collector-tables.js');
	const dbMod = await import('../../src/lib/server/db.js');

	queryCollectorResults = cq.queryCollectorResults;
	recordCollectorResult = cr.recordCollectorResult;
	listCollectorTables = ct.listCollectorTables;
	db = dbMod.db;

	db.prepare(`INSERT OR IGNORE INTO agents (id, name, hostname, os, arch, token_hash) VALUES (?, ?, ?, 'linux', 'amd64', 'tk-cq')`).run(AGENT, 'h-cq', 'h-cq');
});

beforeEach(() => {
	db.prepare("DELETE FROM agent_collector_results WHERE agent_id = ?").run(AGENT);
});

function seedPeripheral(devices: Array<Record<string, unknown>>): void {
	recordCollectorResult({
		agentId: AGENT,
		commandId: null,
		kind: 'peripheral_inventory',
		payload: { devices, recordedAt: new Date().toISOString() }
	});
}

describe('listCollectorTables', () => {
	it('exposes every kind with at least one column', () => {
		const tables = listCollectorTables();
		expect(tables.length).toBeGreaterThanOrEqual(8);
		for (const t of tables) {
			expect(t.columns.length).toBeGreaterThan(0);
		}
	});

	it('marks rowsPath for array-shaped kinds', () => {
		const map = Object.fromEntries(listCollectorTables().map((t) => [t.kind, t]));
		expect(map.peripheral_inventory.rowsPath).toBe('devices');
		expect(map.network_discovery.rowsPath).toBe('devices');
		expect(map.cis_audit.rowsPath).toBe('findings');
		expect(map.reliability_daily.rowsPath).toBeNull();
		expect(map.boot_performance.rowsPath).toBeNull();
	});

	it('attaches enumValues for enum columns', () => {
		const peripheral = listCollectorTables().find((t) => t.kind === 'peripheral_inventory')!;
		const busType = peripheral.columns.find((c) => c.name === 'busType')!;
		expect(busType.enumValues).toEqual(['usb', 'thunderbolt', 'bluetooth']);
	});
});

describe('queryCollectorResults — peripheral_inventory (rowsPath = devices)', () => {
	const devices = [
		{ vendor: 'Logitech', vendorId: '046d', model: 'Mouse', modelId: 'c52b', serial: '', busType: 'usb', class: 'hid', mounted: false, mountPoint: '', verdict: { action: 'allow' } },
		{ vendor: 'SanDisk', vendorId: '0781', model: 'Cruzer', modelId: '5567', serial: 'S1', busType: 'usb', class: 'storage', mounted: true, mountPoint: '/media/usb', verdict: { action: 'block' } },
		{ vendor: 'Apple', vendorId: '05ac', model: 'Magic TB Display', modelId: '1111', serial: 'A1', busType: 'thunderbolt', class: 'video', mounted: false, mountPoint: '', verdict: { action: 'allow' } }
	];

	it('returns one row per device when no filter is supplied', () => {
		seedPeripheral(devices);
		const r = queryCollectorResults({ agentId: AGENT, kind: 'peripheral_inventory', where: [] });
		expect(r.rowsPath).toBe('devices');
		expect(r.rows).toHaveLength(3);
	});

	it('filters by enum column (class)', () => {
		seedPeripheral(devices);
		const r = queryCollectorResults({
			agentId: AGENT, kind: 'peripheral_inventory',
			where: [{ field: 'class', operator: 'eq', value: 'storage' }]
		});
		expect(r.rows).toHaveLength(1);
		expect(r.rows[0].vendor).toBe('SanDisk');
	});

	it('filters into nested fields via verdict.action mapping', () => {
		seedPeripheral(devices);
		const r = queryCollectorResults({
			agentId: AGENT, kind: 'peripheral_inventory',
			where: [{ field: 'verdictAction', operator: 'eq', value: 'block' }]
		});
		expect(r.rows).toHaveLength(1);
		expect(r.rows[0].vendor).toBe('SanDisk');
	});

	it('combines string-contains and boolean-eq filters', () => {
		seedPeripheral(devices);
		const r = queryCollectorResults({
			agentId: AGENT, kind: 'peripheral_inventory',
			where: [
				{ field: 'vendor', operator: 'contains', value: 'San' },
				{ field: 'mounted', operator: 'eq', value: true }
			]
		});
		expect(r.rows).toHaveLength(1);
		expect(r.rows[0].vendor).toBe('SanDisk');
	});

	it('honours the columns projection', () => {
		seedPeripheral(devices);
		const r = queryCollectorResults({
			agentId: AGENT, kind: 'peripheral_inventory',
			columns: ['vendor', 'verdictAction']
		});
		const keys = new Set<string>();
		for (const row of r.rows) for (const k of Object.keys(row)) keys.add(k);
		expect([...keys].sort()).toEqual(['vendor', 'verdictAction']);
	});

	it('rejects unknown columns', () => {
		seedPeripheral(devices);
		expect(() => queryCollectorResults({
			agentId: AGENT, kind: 'peripheral_inventory',
			columns: ['notARealColumn']
		})).toThrow(/unknown column/);
	});

	it('rejects unknown filter fields', () => {
		seedPeripheral(devices);
		expect(() => queryCollectorResults({
			agentId: AGENT, kind: 'peripheral_inventory',
			where: [{ field: 'notARealField', operator: 'eq', value: 'x' }]
		})).toThrow(/unknown field/);
	});

	it('clamps limit to 200', () => {
		seedPeripheral(Array.from({ length: 250 }, (_, i) => ({
			vendor: 'V', vendorId: '0001', model: 'P', modelId: '0001',
			serial: String(i), busType: 'usb', class: 'hid',
			mounted: false, mountPoint: '', verdict: { action: 'allow' }
		})));
		const r = queryCollectorResults({ agentId: AGENT, kind: 'peripheral_inventory', limit: 1000 });
		expect(r.rows.length).toBeLessThanOrEqual(200);
	});
});

describe('queryCollectorResults — top-level snapshot (boot_performance)', () => {
	function seedBoot(payload: Record<string, unknown>): void {
		recordCollectorResult({
			agentId: AGENT, commandId: null, kind: 'boot_performance',
			payload: { ...payload, recordedAt: new Date().toISOString() }
		});
	}

	it('returns one row per snapshot when rowsPath is null', () => {
		seedBoot({ bootTimestamp: '2026-04-30T08:00:00Z', biosSeconds: 5, mainPathSeconds: 10, postBootSeconds: 8, totalSeconds: 23 });
		seedBoot({ bootTimestamp: '2026-05-01T08:00:00Z', biosSeconds: 6, mainPathSeconds: 12, postBootSeconds: 9, totalSeconds: 27 });
		const r = queryCollectorResults({ agentId: AGENT, kind: 'boot_performance', where: [] });
		expect(r.rowsPath).toBeNull();
		expect(r.rows).toHaveLength(2);
	});

	it('filters numeric columns with gt/gte', () => {
		seedBoot({ bootTimestamp: '2026-05-01T08:00:00Z', biosSeconds: 5, mainPathSeconds: 10, postBootSeconds: 8, totalSeconds: 23 });
		seedBoot({ bootTimestamp: '2026-05-02T08:00:00Z', biosSeconds: 6, mainPathSeconds: 12, postBootSeconds: 9, totalSeconds: 27 });
		const r = queryCollectorResults({
			agentId: AGENT, kind: 'boot_performance',
			where: [{ field: 'totalSeconds', operator: 'gt', value: 25 }]
		});
		expect(r.rows).toHaveLength(1);
		expect(r.rows[0].totalSeconds).toBe(27);
	});
});

describe('queryCollectorResults — cis_audit (findings)', () => {
	it('flattens findings and filters by status=fail', () => {
		recordCollectorResult({
			agentId: AGENT, commandId: 'cmd-1', kind: 'cis_audit',
			payload: {
				checkedAt: '2026-05-01T10:00:00Z', platform: 'linux',
				totalChecks: 3, passedChecks: 1, failedChecks: 2, notApplicable: 0, erroredChecks: 0, score: 33,
				findings: [
					{ checkId: '1.5.3', title: 'ASLR', severity: 'high', status: 'pass', message: '', evidence: '' },
					{ checkId: '5.2.5', title: 'PermitRootLogin', severity: 'high', status: 'fail', message: 'permitrootlogin = yes', evidence: 'yes' },
					{ checkId: '3.4.1', title: 'Firewall', severity: 'high', status: 'fail', message: 'no firewall', evidence: '' }
				]
			}
		});
		const r = queryCollectorResults({
			agentId: AGENT, kind: 'cis_audit',
			where: [{ field: 'status', operator: 'eq', value: 'fail' }]
		});
		expect(r.rows).toHaveLength(2);
		expect(r.rows.map((x) => x.checkId).sort()).toEqual(['3.4.1', '5.2.5']);
	});
});

describe('queryCollectorResults — safety', () => {
	it('rejects unknown kind', () => {
		expect(() => queryCollectorResults({ agentId: AGENT, kind: 'no_such_kind' as never })).toThrow(/unknown kind/);
	});

	it('rejects malformed filter values (number coercion)', () => {
		seedPeripheral([{ vendor: 'V', vendorId: '0', model: 'P', modelId: '0', serial: '', busType: 'usb', class: 'hid', mounted: false, mountPoint: '', verdict: { action: 'allow' } }]);
		expect(() => queryCollectorResults({
			agentId: AGENT, kind: 'peripheral_inventory',
			where: [{ field: 'mounted', operator: 'lt', value: 5 }]
		})).toThrow();
	});
});
