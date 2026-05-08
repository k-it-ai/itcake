import { describe, it, expect } from 'vitest';
import { formatOsquerySnapshot, osqueryNdjson, isQueryableCollectorKind } from '../../src/lib/server/osquery-export.js';
import type { AgentCollectorResult } from '../../src/lib/types.js';

const baseSnap: AgentCollectorResult = {
	id: 'r-1',
	agentId: 'agent-1',
	commandId: 'cmd-1',
	kind: 'cis_audit',
	payload: {
		checkedAt: '2026-05-01T10:00:00Z',
		platform: 'linux',
		findings: [
			{ checkId: '1.5.3', title: 'ASLR enabled', severity: 'high', status: 'pass', message: '', evidence: 'kernel.randomize_va_space = 2' },
			{ checkId: '5.2.5', title: 'PermitRootLogin no', severity: 'high', status: 'fail', message: 'permitrootlogin = yes', evidence: 'yes' }
		]
	} as Record<string, unknown>,
	recordedAt: '2026-05-01T10:00:00.000Z'
};

const peripheralSnap: AgentCollectorResult = {
	id: 'r-p',
	agentId: 'agent-2',
	commandId: null,
	kind: 'peripheral_inventory',
	payload: {
		devices: [
			{ vendor: 'Acme', vendorId: '1234', product: 'USB Stick', productId: 'abcd', serialNumber: 'S1', busType: 'usb', deviceClass: 'storage', mounted: true, mountPoint: '/mnt/u', verdict: { action: 'block' } }
		]
	} as Record<string, unknown>,
	recordedAt: '2026-05-02T12:00:00.000Z'
};

const reliabilitySnap: AgentCollectorResult = {
	id: 'r-rel',
	agentId: 'agent-3',
	commandId: null,
	kind: 'reliability_daily',
	payload: {
		day: '2026-05-01',
		uptimeSeconds: 86000,
		crashes: 0,
		hangs: 1,
		serviceFailures: 0,
		hardwareErrors: 0
	} as Record<string, unknown>,
	recordedAt: '2026-05-01T23:59:00.000Z'
};

describe('formatOsquerySnapshot', () => {
	it('emits the osquery snapshot envelope shape', () => {
		const r = formatOsquerySnapshot(baseSnap, 'linux-host-1');
		expect(r.name).toBe('cis_audit');
		expect(r.hostIdentifier).toBe('agent-1');
		expect(r.calendarTime).toBe('2026-05-01T10:00:00.000Z');
		expect(r.unixTime).toBe(Math.floor(Date.parse('2026-05-01T10:00:00.000Z') / 1000));
		expect(r.action).toBe('snapshot');
		expect(r.decorations).toEqual({ hostname: 'linux-host-1' });
	});

	it('expands rowsPath into one row per array element with declared columns', () => {
		const r = formatOsquerySnapshot(baseSnap, 'h');
		expect(r.snapshot).toHaveLength(2);
		expect(r.snapshot[0]).toMatchObject({ checkId: '1.5.3', title: 'ASLR enabled', severity: 'high', status: 'pass' });
		expect(r.snapshot[1]).toMatchObject({ checkId: '5.2.5', status: 'fail' });
		expect(r.columns).toContain('checkId');
		expect(r.columns).toContain('severity');
		expect(r.columns).not.toContain('recordedAt');
		expect(r.columns).not.toContain('commandId');
	});

	it('drills nested paths (e.g. verdict.action)', () => {
		const r = formatOsquerySnapshot(peripheralSnap, 'host-2');
		expect(r.snapshot).toHaveLength(1);
		expect(r.snapshot[0]).toMatchObject({ vendor: 'Acme', verdictAction: 'block', deviceClass: 'storage' });
	});

	it('returns a single-row snapshot for top-level kinds (rowsPath=null)', () => {
		const r = formatOsquerySnapshot(reliabilitySnap, 'host-3');
		expect(r.snapshot).toHaveLength(1);
		expect(r.snapshot[0]).toMatchObject({ day: '2026-05-01', uptimeSeconds: 86000, crashes: 0, hangs: 1 });
	});

	it('returns null for missing fields rather than crashing', () => {
		const stripped: AgentCollectorResult = {
			...baseSnap,
			payload: { findings: [{ checkId: 'X' }] } as Record<string, unknown>
		};
		const r = formatOsquerySnapshot(stripped, 'h');
		expect(r.snapshot[0].checkId).toBe('X');
		expect(r.snapshot[0].title).toBe(null);
		expect(r.snapshot[0].severity).toBe(null);
	});

	it('handles missing rowsPath array as zero rows (no exception)', () => {
		const empty: AgentCollectorResult = {
			...baseSnap,
			payload: {} as Record<string, unknown>
		};
		const r = formatOsquerySnapshot(empty, 'h');
		expect(r.snapshot).toEqual([]);
	});
});

describe('osqueryNdjson', () => {
	it('emits one JSON line per snapshot, terminated with newline', () => {
		const out = osqueryNdjson([baseSnap, peripheralSnap], 'h');
		const lines = out.split('\n').filter(Boolean);
		expect(lines).toHaveLength(2);
		for (const line of lines) {
			const parsed = JSON.parse(line);
			expect(parsed.action).toBe('snapshot');
			expect(typeof parsed.unixTime).toBe('number');
		}
		expect(out.endsWith('\n')).toBe(true);
	});

	it('returns empty string for zero snapshots', () => {
		expect(osqueryNdjson([], 'h')).toBe('');
	});
});

describe('isQueryableCollectorKind', () => {
	it('accepts every registered collector kind', () => {
		expect(isQueryableCollectorKind('cis_audit')).toBe(true);
		expect(isQueryableCollectorKind('peripheral_inventory')).toBe(true);
		expect(isQueryableCollectorKind('reliability_daily')).toBe(true);
	});

	it('rejects unknown kinds', () => {
		expect(isQueryableCollectorKind('processes')).toBe(false);
		expect(isQueryableCollectorKind('')).toBe(false);
	});
});
