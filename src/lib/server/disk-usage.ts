import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR, BACKUP_DIR, UPLOAD_DIR } from './data-dir.js';

export interface DiskUsageReport {
	totalBytes: number;
	breakdown: { name: string; bytes: number; fileCount: number }[];
	free: { bytes: number; percentUsed: number } | null;
	measuredAt: string;
}

const MAX_WALK_DEPTH = 8;

function dirSize(root: string, depth = 0): { bytes: number; count: number } {
	let bytes = 0;
	let count = 0;
	if (depth > MAX_WALK_DEPTH) return { bytes, count };
	let entries: fs.Dirent[];
	try { entries = fs.readdirSync(root, { withFileTypes: true }); }
	catch { return { bytes, count }; }
	for (const entry of entries) {
		const full = path.join(root, entry.name);
		try {
			if (entry.isSymbolicLink()) continue;
			if (entry.isFile()) {
				const st = fs.lstatSync(full);
				bytes += st.size;
				count++;
			} else if (entry.isDirectory()) {
				const inner = dirSize(full, depth + 1);
				bytes += inner.bytes;
				count += inner.count;
			}
		} catch { /* skip unreadable entries */ }
	}
	return { bytes, count };
}

export function getFreeDiskSpace(p: string = DATA_DIR): { bytes: number; percentUsed: number } | null {
	return freeBytes(p);
}

function freeBytes(p: string): { bytes: number; percentUsed: number } | null {
	try {
		const st = fs.statfsSync(p);
		const total = st.blocks * st.bsize;
		const avail = st.bavail * st.bsize;
		if (total <= 0) return null;
		return { bytes: avail, percentUsed: Math.round((1 - avail / total) * 1000) / 10 };
	} catch {
		return null;
	}
}

export function measureDataDirUsage(): DiskUsageReport {
	const breakdown: DiskUsageReport['breakdown'] = [];
	const candidates: { name: string; path: string }[] = [
		{ name: 'database', path: process.env.DATABASE_PATH || path.join(DATA_DIR, 'itcake.db') },
		{ name: 'uploads', path: UPLOAD_DIR },
		{ name: 'backups', path: BACKUP_DIR },
		{ name: 'agent-binaries', path: path.join(DATA_DIR, 'agent-binaries') },
		{ name: 'recordings', path: path.join(DATA_DIR, 'recordings') }
	];
	let totalBytes = 0;
	for (const c of candidates) {
		try {
			const st = fs.lstatSync(c.path);
			if (st.isFile()) {
				breakdown.push({ name: c.name, bytes: st.size, fileCount: 1 });
				totalBytes += st.size;
			} else if (st.isDirectory()) {
				const r = dirSize(c.path);
				breakdown.push({ name: c.name, bytes: r.bytes, fileCount: r.count });
				totalBytes += r.bytes;
			}
		} catch { /* missing — treat as 0 */ }
	}
	return {
		totalBytes,
		breakdown,
		free: freeBytes(DATA_DIR),
		measuredAt: new Date().toISOString()
	};
}
