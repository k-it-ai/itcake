import type { CollectorResultKind } from '$lib/types.js';
import type { FilterFieldDef, FilterFieldType } from './filter-engine.js';

export interface CollectorColumn {
	name: string;
	path: string;
	type: FilterFieldType;
	description: string;
	enumValues?: ReadonlyArray<string>;
}

export interface CollectorTable {
	kind: CollectorResultKind;
	description: string;
	rowsPath: string | null;
	columns: ReadonlyArray<CollectorColumn>;
}

const SNAPSHOT_META: ReadonlyArray<CollectorColumn> = [
	{ name: 'recordedAt', path: '__recorded_at__', type: 'date', description: 'When the snapshot was recorded (server time, ISO-8601)' },
	{ name: 'commandId', path: '__command_id__', type: 'string', description: 'Originating command id (or NULL for operator-initiated snapshots)' }
];

export const COLLECTOR_TABLES: Record<CollectorResultKind, CollectorTable> = {
	peripheral_inventory: {
		kind: 'peripheral_inventory',
		description: 'USB / Thunderbolt / Bluetooth devices enumerated by the agent. Column shape mirrors osquery usb_devices. One row per device per snapshot.',
		rowsPath: 'devices',
		columns: [
			...SNAPSHOT_META,
			{ name: 'vendor', path: 'vendor', type: 'string', description: 'Vendor name from OUI / system_profiler / WMI' },
			{ name: 'vendorId', path: 'vendorId', type: 'string', description: 'Vendor ID (USB VID, lowercase hex)' },
			{ name: 'model', path: 'model', type: 'string', description: 'Model / product name reported by the device' },
			{ name: 'modelId', path: 'modelId', type: 'string', description: 'Model ID (USB PID, lowercase hex)' },
			{ name: 'serial', path: 'serial', type: 'string', description: 'Hardware serial number, if exposed' },
			{ name: 'busType', path: 'busType', type: 'enum', description: 'usb | thunderbolt | bluetooth', enumValues: ['usb', 'thunderbolt', 'bluetooth'] },
			{ name: 'class', path: 'class', type: 'enum', description: 'storage | hid | audio | network | video | printer | unknown', enumValues: ['storage', 'hid', 'audio', 'network', 'video', 'printer', 'unknown'] },
			{ name: 'mounted', path: 'mounted', type: 'boolean', description: 'Whether the device is currently mounted (storage class only)' },
			{ name: 'mountPoint', path: 'mountPoint', type: 'string', description: 'Mount point path (storage class only)' },
			{ name: 'verdictAction', path: 'verdict.action', type: 'enum', description: 'Server-evaluated policy verdict for this device', enumValues: ['allow', 'block', 'alert', 'read_only'] }
		]
	},
	network_discovery: {
		kind: 'network_discovery',
		description: 'LAN devices observed by the agent (ARP, ping, port-scan). Column shape mirrors osquery arp_cache (address, mac) where applicable. One row per device per snapshot.',
		rowsPath: 'devices',
		columns: [
			...SNAPSHOT_META,
			{ name: 'address', path: 'address', type: 'string', description: 'IPv4 address of the discovered device (or IPv6 if discovered)' },
			{ name: 'mac', path: 'mac', type: 'string', description: 'MAC address (lowercase, colon-separated, may be empty)' },
			{ name: 'hostname', path: 'hostname', type: 'string', description: 'Reverse-DNS hostname, may be empty' },
			{ name: 'vendor', path: 'vendor', type: 'string', description: 'OUI vendor lookup (compiled-in top-200 prefixes)' },
			{ name: 'lastSeen', path: 'lastSeen', type: 'date', description: 'When the device was last responsive during this scan (ISO-8601)' }
		]
	},
	network_baseline: {
		kind: 'network_baseline',
		description: 'Operator-confirmed LAN baseline. Same shape as network_discovery; queries return the trusted device set.',
		rowsPath: 'devices',
		columns: [
			...SNAPSHOT_META,
			{ name: 'address', path: 'address', type: 'string', description: 'IPv4 address' },
			{ name: 'mac', path: 'mac', type: 'string', description: 'MAC address' },
			{ name: 'hostname', path: 'hostname', type: 'string', description: 'Hostname at baseline time' },
			{ name: 'vendor', path: 'vendor', type: 'string', description: 'OUI vendor at baseline time' },
			{ name: 'lastSeen', path: 'lastSeen', type: 'date', description: 'Last-seen at baseline time' }
		]
	},
	cis_audit: {
		kind: 'cis_audit',
		description: 'CIS Benchmark check results. One row per check per audit snapshot.',
		rowsPath: 'findings',
		columns: [
			...SNAPSHOT_META,
			{ name: 'checkId', path: 'checkId', type: 'string', description: 'CIS Benchmark check ID (xccdf-style, e.g. "1.5.3" or "xccdf_org.cisecurity_…")' },
			{ name: 'title', path: 'title', type: 'string', description: 'Check title' },
			{ name: 'severity', path: 'severity', type: 'enum', description: 'low | medium | high', enumValues: ['low', 'medium', 'high'] },
			{ name: 'status', path: 'status', type: 'enum', description: 'pass | fail | not_applicable | error', enumValues: ['pass', 'fail', 'not_applicable', 'error'] },
			{ name: 'message', path: 'message', type: 'string', description: 'Human-readable summary (esp. for failed checks)' }
		]
	},
	reliability_daily: {
		kind: 'reliability_daily',
		description: 'Daily-bucket reliability metrics from the agent (uptime, crashes, hangs, service failures, hardware errors). One row per snapshot.',
		rowsPath: null,
		columns: [
			...SNAPSHOT_META,
			{ name: 'day', path: 'day', type: 'date', description: 'UTC day this bucket covers (ISO-8601 date)' },
			{ name: 'uptimeSeconds', path: 'uptimeSeconds', type: 'number', description: 'Total uptime observed during the day' },
			{ name: 'crashes', path: 'crashes', type: 'number', description: 'Number of process / kernel crashes' },
			{ name: 'hangs', path: 'hangs', type: 'number', description: 'Number of detected hangs / spindumps' },
			{ name: 'serviceFailures', path: 'serviceFailures', type: 'number', description: 'Number of service-manager-reported failures' },
			{ name: 'hardwareErrors', path: 'hardwareErrors', type: 'number', description: 'Number of hardware error events' }
		]
	},
	boot_performance: {
		kind: 'boot_performance',
		description: 'Boot-phase timing collected by the agent (BIOS/loader/kernel/userspace). One row per snapshot.',
		rowsPath: null,
		columns: [
			...SNAPSHOT_META,
			{ name: 'bootTimestamp', path: 'bootTimestamp', type: 'date', description: 'Wall-clock boot time (ISO-8601)' },
			{ name: 'biosSeconds', path: 'biosSeconds', type: 'number', description: 'Firmware/BIOS phase, 0 on macOS where unavailable' },
			{ name: 'mainPathSeconds', path: 'mainPathSeconds', type: 'number', description: 'Kernel + early userspace phase' },
			{ name: 'postBootSeconds', path: 'postBootSeconds', type: 'number', description: 'Post-boot userspace phase' },
			{ name: 'desktopReadySeconds', path: 'desktopReadySeconds', type: 'number', description: 'Time to first desktop / loginwindow' },
			{ name: 'totalSeconds', path: 'totalSeconds', type: 'number', description: 'BIOS + main-path + post-boot' }
		]
	},
	hardware_warranty: {
		kind: 'hardware_warranty',
		description: 'SMBIOS / system-profiler hardware identity + warranty status. One row per snapshot.',
		rowsPath: null,
		columns: [
			...SNAPSHOT_META,
			{ name: 'vendor', path: 'vendor', type: 'string', description: 'System vendor (e.g. Dell, Apple, HP)' },
			{ name: 'productName', path: 'productName', type: 'string', description: 'Model / product name' },
			{ name: 'serial', path: 'serial', type: 'string', description: 'Hardware serial number' },
			{ name: 'biosVersion', path: 'biosVersion', type: 'string', description: 'BIOS / firmware version string' },
			{ name: 'biosDate', path: 'biosDate', type: 'string', description: 'BIOS release date (vendor format)' },
			{ name: 'chassisType', path: 'chassisType', type: 'string', description: 'Chassis type (laptop, desktop, server, etc.)' },
			{ name: 'warrantyEndDate', path: 'warrantyEndDate', type: 'date', description: 'Computed warranty end date (operator override wins over agent-detected)' },
			{ name: 'status', path: 'status', type: 'enum', description: 'active | expiring | expired (computed from warrantyEndDate)', enumValues: ['active', 'expiring', 'expired'] }
		]
	},
	filesystem_analysis: {
		kind: 'filesystem_analysis',
		description: 'Filesystem-cleanup analysis snapshot. Top-level scalar fields only — use get_collector_results to inspect the nested categories/top-files breakdown.',
		rowsPath: null,
		columns: [
			...SNAPSHOT_META,
			{ name: 'totalScannedBytes', path: 'totalScannedBytes', type: 'number', description: 'Sum of bytes scanned during this run' },
			{ name: 'durationSeconds', path: 'durationSeconds', type: 'number', description: 'Wall-clock scan duration' },
			{ name: 'truncated', path: 'truncated', type: 'boolean', description: 'Whether the scan stopped at the timeout/cap' }
		]
	}
};

const COLUMN_NAME_RE = /^[a-zA-Z_][a-zA-Z0-9_]*$/;

for (const [kind, table] of Object.entries(COLLECTOR_TABLES)) {
	for (const col of table.columns) {
		if (!COLUMN_NAME_RE.test(col.name)) {
			throw new Error(`collector-tables: invalid column name "${col.name}" in kind "${kind}" — must match ${COLUMN_NAME_RE}`);
		}
	}
}

const PATH_RE = /^[a-zA-Z_][a-zA-Z0-9_]*(\.[a-zA-Z_][a-zA-Z0-9_]*)*$/;

function jsonExtract(root: string, path: string): string {
	if (path === '__recorded_at__') return 'r.recorded_at';
	if (path === '__command_id__') return 'r.command_id';
	if (!PATH_RE.test(path)) {
		throw new Error(`collector-tables: invalid path "${path}" — registry bug`);
	}
	return `json_extract(${root}, '$.${path}')`;
}

export function fieldsForKind(kind: CollectorResultKind): ReadonlyMap<string, FilterFieldDef> {
	const table = COLLECTOR_TABLES[kind];
	if (!table) throw new Error(`collector-tables: unknown kind "${kind}"`);
	const root = table.rowsPath ? 'j.value' : 'r.payload';
	const out = new Map<string, FilterFieldDef>();
	for (const col of table.columns) {
		out.set(col.name, {
			key: col.name,
			label: col.name,
			type: col.type,
			column: jsonExtract(root, col.path),
			...(col.enumValues ? { enumValues: col.enumValues as string[] } : {})
		});
	}
	return out;
}

export function listCollectorTables(): Array<{
	kind: CollectorResultKind;
	description: string;
	rowsPath: string | null;
	columns: Array<{ name: string; type: FilterFieldType; description: string; enumValues?: string[] }>;
}> {
	return Object.values(COLLECTOR_TABLES).map((t) => ({
		kind: t.kind,
		description: t.description,
		rowsPath: t.rowsPath,
		columns: t.columns.map((c) => ({
			name: c.name,
			type: c.type,
			description: c.description,
			...(c.enumValues ? { enumValues: c.enumValues as string[] } : {})
		}))
	}));
}
