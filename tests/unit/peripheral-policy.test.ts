import { describe, it, expect, beforeAll } from 'vitest';
import { mkdirSync, rmSync, existsSync } from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';

const TEST_DIR = path.resolve('data-test-peripheral-policy');

let evaluateDevice: typeof import('../../src/services/peripheral.js').evaluateDevice;
let getPolicy: typeof import('../../src/services/peripheral.js').getPolicy;
let setPolicy: typeof import('../../src/services/peripheral.js').setPolicy;
let processPeripheralScanResult: typeof import('../../src/services/peripheral.js').processPeripheralScanResult;
let listFindingsByCategory: typeof import('../../src/services/agent-findings.js').listFindingsByCategory;
let getLatestCollectorResult: typeof import('../../src/services/agent-collector-results.js').getLatestCollectorResult;
let db: typeof import('../../src/lib/server/db.js').db;
type PeripheralDevice = import('../../src/services/peripheral.js').PeripheralDevice;

beforeAll(async () => {
	if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
	mkdirSync(TEST_DIR, { recursive: true });
	mkdirSync(path.join(TEST_DIR, 'backups'), { recursive: true });
	mkdirSync(path.join(TEST_DIR, 'uploads'), { recursive: true });
	process.env.DATABASE_PATH = path.join(TEST_DIR, 'peripheral.db');
	process.env.DATA_DIR = TEST_DIR;
	process.env.SESSION_SECRET ||= randomBytes(32).toString('hex');

	const mod = await import('../../src/services/peripheral.js');
	const fmod = await import('../../src/services/agent-findings.js');
	const cmod = await import('../../src/services/agent-collector-results.js');
	const dbMod = await import('../../src/lib/server/db.js');
	evaluateDevice = mod.evaluateDevice;
	getPolicy = mod.getPolicy;
	setPolicy = mod.setPolicy;
	processPeripheralScanResult = mod.processPeripheralScanResult;
	listFindingsByCategory = fmod.listFindingsByCategory;
	getLatestCollectorResult = cmod.getLatestCollectorResult;
	db = dbMod.db;

	db.prepare(`INSERT INTO agents (id, name, hostname, os, arch, token_hash, data) VALUES ('p-1', 'p-1', 'p-1', 'linux', 'amd64', 'tk-p-1', '{}')`).run();
});

const sd: PeripheralDevice = {
	vendor: 'SanDisk', vendorId: '0781', product: 'Cruzer', productId: '5567',
	serialNumber: '1234ABCD', busType: 'usb', deviceClass: 'storage', mounted: false, mountPoint: ''
};
const yk: PeripheralDevice = {
	vendor: 'Yubico', vendorId: '1050', product: 'YubiKey', productId: '0407',
	serialNumber: 'YK-001', busType: 'usb', deviceClass: 'hid', mounted: false, mountPoint: ''
};

describe('evaluateDevice', () => {
	it('class mismatch implicitly allows', () => {
		const v = evaluateDevice(yk, { deviceClass: 'storage', action: 'block', exceptions: [] });
		expect(v.action).toBe('allow');
		expect(v.matchedException).toBe(null);
	});

	it('storage device with action=block returns block', () => {
		const v = evaluateDevice(sd, { deviceClass: 'storage', action: 'block', exceptions: [] });
		expect(v.action).toBe('block');
	});

	it('matching vendor+product exception allows', () => {
		const v = evaluateDevice(yk, {
			deviceClass: 'all_usb', action: 'block',
			exceptions: [{ vendor: 'Yubico', product: 'YubiKey', allow: true }]
		});
		expect(v.action).toBe('allow');
		expect(v.matchedException?.vendor).toBe('Yubico');
	});

	it('vendor-only exception matches', () => {
		const v = evaluateDevice(sd, {
			deviceClass: 'storage', action: 'block',
			exceptions: [{ vendor: 'SanDisk', allow: true }]
		});
		expect(v.action).toBe('allow');
	});

	it('expired exception falls through to policy action', () => {
		const past = new Date(Date.now() - 60_000).toISOString();
		const v = evaluateDevice(sd, {
			deviceClass: 'storage', action: 'block',
			exceptions: [{ vendor: 'SanDisk', allow: true, expiresAt: past }]
		});
		expect(v.action).toBe('block');
	});

	it('future exception still allows', () => {
		const future = new Date(Date.now() + 86_400_000).toISOString();
		const v = evaluateDevice(sd, {
			deviceClass: 'storage', action: 'block',
			exceptions: [{ vendor: 'SanDisk', allow: true, expiresAt: future }]
		});
		expect(v.action).toBe('allow');
	});

	it('empty exception (no fields) is ignored', () => {
		const v = evaluateDevice(sd, {
			deviceClass: 'storage', action: 'block',
			exceptions: [{ allow: true }]
		});
		expect(v.action).toBe('block');
	});

	it('case-insensitive matching', () => {
		const v = evaluateDevice({ ...sd, vendor: 'sandisk' }, {
			deviceClass: 'storage', action: 'block',
			exceptions: [{ vendor: 'SANDISK', allow: true }]
		});
		expect(v.action).toBe('allow');
	});

	it('all_usb covers hid devices', () => {
		const v = evaluateDevice(yk, { deviceClass: 'all_usb', action: 'alert', exceptions: [] });
		expect(v.action).toBe('alert');
	});
});

describe('getPolicy / setPolicy', () => {
	it('default policy when none set', () => {
		const p = getPolicy('p-1');
		expect(p.deviceClass).toBe('storage');
		expect(p.action).toBe('alert');
		expect(p.exceptions).toEqual([]);
	});

	it('setPolicy persists and audit-logs', () => {
		const next = setPolicy('p-1', {
			deviceClass: 'all_usb', action: 'block',
			exceptions: [{ vendor: 'Yubico', allow: true }]
		}, 'u-1');
		expect(next.deviceClass).toBe('all_usb');
		expect(next.action).toBe('block');
		const got = getPolicy('p-1');
		expect(got.deviceClass).toBe('all_usb');
		const changes = db.prepare("SELECT entity_type, entity_id, action FROM changes WHERE entity_id = 'p-1' AND entity_type = 'agent'").all() as Array<{ entity_type: string; entity_id: string; action: string }>;
		expect(changes.length).toBeGreaterThan(0);
	});

	it('rejects exception with no fields', () => {
		expect(() => setPolicy('p-1', {
			deviceClass: 'storage', action: 'block',
			// @ts-expect-error invalid: exception schema requires at least one field
			exceptions: [{ allow: true }]
		}, 'u-1')).toThrow();
	});
});

describe('processPeripheralScanResult', () => {
	it('records findings for blocked devices and stores inventory', () => {
		setPolicy('p-1', {
			deviceClass: 'storage', action: 'block',
			exceptions: []
		}, 'u-1');
		processPeripheralScanResult('cmd-scan-1', 'p-1', { devices: [sd, yk] });
		const findings = listFindingsByCategory('p-1', 'peripheral', 100);
		expect(findings.find(f => (f.evidence as { device?: { vendorId?: string } }).device?.vendorId === '0781')).toBeTruthy();
		expect(findings.find(f => (f.evidence as { device?: { vendorId?: string } }).device?.vendorId === '1050')).toBeFalsy();
		const inv = getLatestCollectorResult('p-1', 'peripheral_inventory');
		expect(inv).not.toBe(null);
		expect((inv?.payload.devices as unknown[]).length).toBe(2);
	});

	it('repeated scan dedups findings', () => {
		const before = listFindingsByCategory('p-1', 'peripheral', 100).length;
		processPeripheralScanResult('cmd-scan-2', 'p-1', { devices: [sd] });
		const after = listFindingsByCategory('p-1', 'peripheral', 100).length;
		expect(after).toBe(before);
	});

	it('exception suppresses finding on next scan', () => {
		setPolicy('p-1', {
			deviceClass: 'storage', action: 'block',
			exceptions: [{ vendor: 'SanDisk', allow: true }]
		}, 'u-1');
		processPeripheralScanResult('cmd-scan-3', 'p-1', { devices: [sd] });
		const f = listFindingsByCategory('p-1', 'peripheral', 100).find(x => (x.evidence as { device?: { vendorId?: string } }).device?.vendorId === '0781');
		expect(f?.state).toBe('open');
	});
});
