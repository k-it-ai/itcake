/**
 * `operatorTodayDate` is the single source of truth for "today" in the
 * operator's configured timezone — used by invoice paid date, credit-note
 * date, recurring next-run date, and the year component in numbered-id
 * formatting. Previously several spots used `dayjs()` (process-local TZ);
 * on a UTC server with an operator in CET, that produced day-boundary
 * skew in the stored value vs the operator's local clock.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { mkdirSync, rmSync, existsSync } from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';

const TEST_DIR = path.resolve('data-test-operator-tz-today');

let operatorTodayDate: typeof import('../../src/lib/server/db.js').operatorTodayDate;
let operatorTodayAsDate: typeof import('../../src/lib/server/db.js').operatorTodayAsDate;
let setSetting: typeof import('../../src/lib/server/db.js').setSetting;

beforeAll(async () => {
	if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
	mkdirSync(TEST_DIR, { recursive: true });
	process.env.DATABASE_PATH = path.join(TEST_DIR, 'tz.db');
	process.env.DATA_DIR = TEST_DIR;
	process.env.SESSION_SECRET ||= randomBytes(32).toString('hex');

	const mod = await import('../../src/lib/server/db.js');
	operatorTodayDate = mod.operatorTodayDate;
	operatorTodayAsDate = mod.operatorTodayAsDate;
	setSetting = mod.setSetting;
});

describe('operatorTodayDate', () => {
	it('returns YYYY-MM-DD shape', () => {
		setSetting('general', { language: 'en', timezone: 'UTC' });
		const s = operatorTodayDate();
		expect(s).toMatch(/^\d{4}-\d{2}-\d{2}$/);
	});

	it('respects an explicit operator-configured timezone', () => {
		// 2026-01-01T00:30:00Z is 01:30 CET (+1) → still 2026-01-01 in Berlin
		// AND 09:30 JST (+9) → 2026-01-01. Pick a moment where TZ shift
		// changes the date: 2025-12-31T23:30Z = 2026-01-01 00:30 CET.
		setSetting('general', { language: 'en', timezone: 'Europe/Berlin' });
		const moment = new Date('2025-12-31T23:30:00Z');
		expect(operatorTodayDate(moment)).toBe('2026-01-01');

		setSetting('general', { language: 'en', timezone: 'America/Los_Angeles' });
		// Same UTC moment is 15:30 PST on 2025-12-31.
		expect(operatorTodayDate(moment)).toBe('2025-12-31');
	});

	it('falls back to UTC when no timezone is configured', () => {
		setSetting('general', { language: 'en' }); // no timezone field
		const moment = new Date('2025-12-31T23:30:00Z');
		expect(operatorTodayDate(moment)).toBe('2025-12-31');
	});

	it('tolerates an empty-string timezone (treats as UTC)', () => {
		setSetting('general', { language: 'en', timezone: '' });
		const moment = new Date('2025-12-31T23:30:00Z');
		expect(operatorTodayDate(moment)).toBe('2025-12-31');
	});
});

describe('operatorTodayAsDate', () => {
	it('returns a Date whose ISO matches operatorTodayDate at midnight UTC', () => {
		setSetting('general', { language: 'en', timezone: 'Europe/Berlin' });
		const moment = new Date('2025-12-31T23:30:00Z');
		const d = operatorTodayAsDate(moment);
		expect(d.toISOString()).toBe('2026-01-01T00:00:00.000Z');
	});

	it('feeds dayjs().format("YYYY") correctly across day boundaries', async () => {
		setSetting('general', { language: 'en', timezone: 'Europe/Berlin' });
		const moment = new Date('2025-12-31T23:30:00Z');
		const dayjs = (await import('dayjs')).default;
		expect(dayjs(operatorTodayAsDate(moment)).format('YYYY')).toBe('2026');

		setSetting('general', { language: 'en', timezone: 'America/Los_Angeles' });
		expect(dayjs(operatorTodayAsDate(moment)).format('YYYY')).toBe('2025');
	});
});
