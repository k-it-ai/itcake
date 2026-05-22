import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { mkdirSync, rmSync, existsSync } from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';

/**
 * Three knobs went from hard-coded constants to operator-tunable
 * settings. This suite verifies (1) the defaults match the previous
 * constants exactly, so a fresh install behaves identically; (2) the
 * clamps at the consumer reject pathological values from a tampered
 * settings row; (3) the consumer actually reads the live setting,
 * not a captured-at-load copy.
 */

const TEST_DIR = path.resolve('data-test-tunable-settings');

let db: typeof import('../../src/lib/server/db.js').db;
let setSetting: typeof import('../../src/lib/server/db.js').setSetting;
let getSetting: typeof import('../../src/lib/server/db.js').getSetting;
let pruneExpiredRemoteSessions: typeof import('../../src/services/remote-sessions.js').pruneExpiredRemoteSessions;
let getAgentSecurityPostureCached: typeof import('../../src/services/security-posture.js').getAgentSecurityPostureCached;
let _resetPostureCacheForTests: typeof import('../../src/services/security-posture.js')._resetPostureCacheForTests;

beforeAll(async () => {
	if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
	mkdirSync(TEST_DIR, { recursive: true });
	process.env.DATABASE_PATH = path.join(TEST_DIR, 'tun.db');
	process.env.DATA_DIR = TEST_DIR;
	process.env.SESSION_SECRET ||= randomBytes(32).toString('hex');

	const dbMod = await import('../../src/lib/server/db.js');
	const rsMod = await import('../../src/services/remote-sessions.js');
	const postureMod = await import('../../src/services/security-posture.js');

	db = dbMod.db;
	setSetting = dbMod.setSetting;
	getSetting = dbMod.getSetting;
	pruneExpiredRemoteSessions = rsMod.pruneExpiredRemoteSessions;
	getAgentSecurityPostureCached = postureMod.getAgentSecurityPostureCached;
	_resetPostureCacheForTests = postureMod._resetPostureCacheForTests;

	db.prepare("INSERT OR IGNORE INTO agents (id, name, hostname, os, arch, token_hash) VALUES ('tun-a', 'h', 'h', 'linux', 'amd64', 'h')").run();
	db.prepare("INSERT OR IGNORE INTO users (id, email, name, password_hash) VALUES ('tun-u', 'u@x', 'u', '')").run();
});

describe('settings defaults match the previous hard-coded constants', () => {
	it('remoteDesktop.endedRetentionDays defaults to 90', () => {
		const rd = getSetting<{ endedRetentionDays?: number }>('remoteDesktop');
		expect(rd.endedRetentionDays).toBe(90);
	});

	it('remoteDesktop.orphanRetentionDays defaults to 7', () => {
		const rd = getSetting<{ orphanRetentionDays?: number }>('remoteDesktop');
		expect(rd.orphanRetentionDays).toBe(7);
	});

	it('advanced.auditIntegrityRateLimit defaults to 10', () => {
		const a = getSetting<{ auditIntegrityRateLimit?: number }>('advanced');
		expect(a.auditIntegrityRateLimit).toBe(10);
	});

	it('rmm.postureCacheTtlSeconds defaults to 300', () => {
		const r = getSetting<{ postureCacheTtlSeconds?: number }>('rmm');
		expect(r.postureCacheTtlSeconds).toBe(300);
	});
});

describe('remote-sessions prune honors live retention settings', () => {
	beforeEach(() => {
		db.prepare("DELETE FROM remote_sessions WHERE agent_id = 'tun-a'").run();
	});

	function seed(id: string, opts: { endedDaysAgo?: number; consumedDaysAgo?: number }): void {
		const endedExpr = opts.endedDaysAgo !== undefined ? `datetime('now', '-${opts.endedDaysAgo} days')` : 'NULL';
		const consumedExpr = opts.consumedDaysAgo !== undefined ? `datetime('now', '-${opts.consumedDaysAgo} days')` : 'NULL';
		db.prepare(
			`INSERT INTO remote_sessions (id, agent_id, user_id, token_hash, protocol, expires_at, consumed_at, ended_at, client_ip, user_agent, created_at)
			 VALUES (?, 'tun-a', 'tun-u', ?, 'rdp', datetime('now', '+10 minutes'), ${consumedExpr}, ${endedExpr}, '127.0.0.1', '', datetime('now', '-100 days'))`
		).run(id, 'tk-' + id);
	}

	function exists(id: string): boolean {
		return !!db.prepare("SELECT id FROM remote_sessions WHERE id = ?").get(id);
	}

	it('honors a custom endedRetentionDays — 5-day window keeps a 4-day-old ended row, deletes a 6-day-old one', () => {
		const rd = getSetting<Record<string, unknown>>('remoteDesktop');
		setSetting('remoteDesktop', { ...rd, endedRetentionDays: 5, orphanRetentionDays: 7 });

		seed('keep-4d-ended', { endedDaysAgo: 4 });
		seed('drop-6d-ended', { endedDaysAgo: 6 });

		pruneExpiredRemoteSessions();

		expect(exists('keep-4d-ended')).toBe(true);
		expect(exists('drop-6d-ended')).toBe(false);
	});

	it('honors a custom orphanRetentionDays — 2-day window keeps a 1-day-old orphan, deletes a 3-day-old one', () => {
		const rd = getSetting<Record<string, unknown>>('remoteDesktop');
		setSetting('remoteDesktop', { ...rd, endedRetentionDays: 90, orphanRetentionDays: 2 });

		seed('keep-1d-orphan', { consumedDaysAgo: 1 });
		seed('drop-3d-orphan', { consumedDaysAgo: 3 });

		pruneExpiredRemoteSessions();

		expect(exists('keep-1d-orphan')).toBe(true);
		expect(exists('drop-3d-orphan')).toBe(false);
	});

	it('clamps a tampered row that sets negative retention to the floor of 1', () => {
		const rd = getSetting<Record<string, unknown>>('remoteDesktop');
		// Write past the validator (raw setSetting) to mimic DB tampering.
		setSetting('remoteDesktop', { ...rd, endedRetentionDays: -5, orphanRetentionDays: -5 });

		// 0-day-old ended row must survive (-5 clamped to 1 means "older than 1 day").
		seed('keep-fresh-ended', { endedDaysAgo: 0 });

		pruneExpiredRemoteSessions();
		expect(exists('keep-fresh-ended')).toBe(true);
	});
});

describe('posture cache TTL honors live setting', () => {
	beforeEach(() => {
		_resetPostureCacheForTests();
	});

	it('TTL=0 disables caching — every call recomputes (different object identity)', () => {
		const rmm = getSetting<Record<string, unknown>>('rmm');
		setSetting('rmm', { ...rmm, postureCacheTtlSeconds: 0 });

		const a = getAgentSecurityPostureCached('tun-a');
		const b = getAgentSecurityPostureCached('tun-a');
		expect(b).not.toBe(a);
	});

	it('TTL>0 caches — same object identity until invalidation', () => {
		const rmm = getSetting<Record<string, unknown>>('rmm');
		setSetting('rmm', { ...rmm, postureCacheTtlSeconds: 300 });

		const a = getAgentSecurityPostureCached('tun-a');
		const b = getAgentSecurityPostureCached('tun-a');
		expect(b).toBe(a);
	});

	it('clamps a tampered negative TTL to the 5-min default', () => {
		const rmm = getSetting<Record<string, unknown>>('rmm');
		setSetting('rmm', { ...rmm, postureCacheTtlSeconds: -1 });

		const a = getAgentSecurityPostureCached('tun-a');
		const b = getAgentSecurityPostureCached('tun-a');
		// Default fallback is positive → cache should serve a hit.
		expect(b).toBe(a);
	});
});
