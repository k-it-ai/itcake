import { error } from '@sveltejs/kit';
import { db } from './db.js';

// SQLite-backed rate limiter: survives process restarts and works across workers.
// Table is created if it doesn't exist.
db.exec(`
	CREATE TABLE IF NOT EXISTS rate_limits (
		key TEXT PRIMARY KEY,
		count INTEGER NOT NULL DEFAULT 0,
		reset_at INTEGER NOT NULL
	)
`);

const MAX_ATTEMPTS_IP = 10;     // per IP (generous — multiple users may share IP)
const MAX_ATTEMPTS_EMAIL = 3;   // per email (strict — protects individual accounts)
const MAX_ATTEMPTS_GLOBAL = 30; // all-IPs combined — catches distributed botnet attacks
const WINDOW_MS = 15 * 60 * 1000; // 15 minutes

const stmtGet = db.prepare('SELECT count, reset_at FROM rate_limits WHERE key = ?');
const stmtUpsert = db.prepare(`
	INSERT INTO rate_limits (key, count, reset_at) VALUES (?, 1, ?)
	ON CONFLICT(key) DO UPDATE SET
		count = CASE WHEN rate_limits.reset_at < ?
			THEN 1
			ELSE rate_limits.count + 1
		END,
		reset_at = CASE WHEN rate_limits.reset_at < ?
			THEN excluded.reset_at
			ELSE rate_limits.reset_at
		END
`);
const stmtDelete = db.prepare('DELETE FROM rate_limits WHERE key = ?');
const stmtPrune = db.prepare('DELETE FROM rate_limits WHERE reset_at < ?');

export function checkRateLimit(key: string, max: number, message = 'Too many attempts'): void {
	const now = Date.now();
	const entry = stmtGet.get(key) as { count: number; reset_at: number } | undefined;
	if (entry && now < entry.reset_at && entry.count >= max) {
		const retryAfter = Math.ceil((entry.reset_at - now) / 1000);
		throw error(429, `${message}. Try again in ${retryAfter} seconds.`);
	}
}

export function recordAttempt(key: string): void {
	const now = Date.now();
	const resetAt = now + WINDOW_MS;
	stmtUpsert.run(key, resetAt, now, now);
}

/**
 * Atomically check rate limit AND record attempt in a single transaction.
 * Closes the TOCTOU gap where concurrent requests could pass the check
 * before any record their attempt (e.g., during slow bcrypt operations).
 */
const checkAndRecordTx = db.transaction((key: string, max: number, message: string) => {
	const now = Date.now();
	const entry = stmtGet.get(key) as { count: number; reset_at: number } | undefined;
	if (entry && now < entry.reset_at && entry.count >= max) {
		const retryAfter = Math.ceil((entry.reset_at - now) / 1000);
		throw error(429, `${message}. Try again in ${retryAfter} seconds.`);
	}
	const resetAt = now + WINDOW_MS;
	stmtUpsert.run(key, resetAt, now, now);
});

export function checkAndRecordAttempt(key: string, max: number, message = 'Too many attempts'): void {
	checkAndRecordTx(key, max, message);
}

function clearAttempts(key: string): void {
	stmtDelete.run(key);
}

// Periodically clean stale entries (every 30 min)
setInterval(() => {
	try { stmtPrune.run(Date.now()); } catch (e) { console.error('Rate limit pruning failed:', e instanceof Error ? e.message : e); }
}, 30 * 60 * 1000).unref();

/**
 * Check rate limits for a login attempt. Throws 429 if exceeded.
 * When email is omitted, only the IP-level limit is checked (pre-parse guard).
 *
 * NOTE: this is the read-only check kept for the pre-parse path that
 * doesn't yet know the email. The actual login flow MUST use
 * `checkAndRecordLoginAttempt` to close the bcrypt-window race where
 * many concurrent guesses could all pass the check before any of them
 * record the attempt.
 */
export function checkLoginRateLimit(ip: string, email?: string): void {
	checkRateLimit('login_global', MAX_ATTEMPTS_GLOBAL, 'Too many login attempts');
	checkRateLimit(`ip:${ip}`, MAX_ATTEMPTS_IP, 'Too many login attempts');
	if (email) {
		checkRateLimit(`email:${email.toLowerCase()}`, MAX_ATTEMPTS_EMAIL, 'Too many login attempts');
	}
}

/**
 * Atomically check AND record an attempt against all three login buckets
 * (global, IP, email) in one transaction — closes the TOCTOU window
 * where ~100 ms of bcrypt time would otherwise let dozens of concurrent
 * guesses pass before any of them recorded the attempt. Successful
 * authentication should call `clearLoginAttempts` to refund the IP and
 * email buckets (the global counter stays — it's the distributed-botnet
 * fence and shouldn't be cleared per-success).
 */
const checkAndRecordLoginTx = db.transaction((ip: string, email: string) => {
	const now = Date.now();
	const resetAt = now + WINDOW_MS;
	const buckets: Array<{ key: string; max: number }> = [
		{ key: 'login_global', max: MAX_ATTEMPTS_GLOBAL },
		{ key: `ip:${ip}`, max: MAX_ATTEMPTS_IP },
		{ key: `email:${email.toLowerCase()}`, max: MAX_ATTEMPTS_EMAIL }
	];
	for (const b of buckets) {
		const entry = stmtGet.get(b.key) as { count: number; reset_at: number } | undefined;
		if (entry && now < entry.reset_at && entry.count >= b.max) {
			const retryAfter = Math.ceil((entry.reset_at - now) / 1000);
			throw error(429, `Too many login attempts. Try again in ${retryAfter} seconds.`);
		}
	}
	for (const b of buckets) {
		stmtUpsert.run(b.key, resetAt, now, now);
	}
});

export function checkAndRecordLoginAttempt(ip: string, email: string): void {
	checkAndRecordLoginTx(ip, email);
}

export function clearLoginAttempts(ip: string, email: string): void {
	clearAttempts(`ip:${ip}`);
	clearAttempts(`email:${email.toLowerCase()}`);
}

/**
 * Atomically check + record rate limit for setup attempts.
 */
export function checkAndRecordSetupAttempt(ip: string): void {
	checkAndRecordAttempt(`setup:${ip}`, MAX_ATTEMPTS_IP, 'Too many setup attempts');
}

/**
 * Rate limit for email sending: max 20 emails per 15-minute window per user.
 * Atomically checks and records.
 */
const MAX_EMAILS = 20;

export function checkAndRecordEmailSend(userId: string): void {
	checkAndRecordAttempt(`email_send:${userId}`, MAX_EMAILS, 'Email rate limit exceeded');
}
