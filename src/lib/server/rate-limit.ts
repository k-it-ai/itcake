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
		count = CASE WHEN excluded.reset_at > rate_limits.reset_at
			THEN 1
			ELSE rate_limits.count + 1
		END,
		reset_at = CASE WHEN excluded.reset_at > rate_limits.reset_at
			THEN excluded.reset_at
			ELSE rate_limits.reset_at
		END
`);
const stmtDelete = db.prepare('DELETE FROM rate_limits WHERE key = ?');
const stmtPrune = db.prepare('DELETE FROM rate_limits WHERE reset_at < ?');

function checkRateLimit(key: string, max: number, message = 'Too many attempts'): void {
	const now = Date.now();
	const entry = stmtGet.get(key) as { count: number; reset_at: number } | undefined;
	if (entry && now < entry.reset_at && entry.count >= max) {
		const retryAfter = Math.ceil((entry.reset_at - now) / 1000);
		throw error(429, `${message}. Try again in ${retryAfter} seconds.`);
	}
}

function recordAttempt(key: string): void {
	const resetAt = Date.now() + WINDOW_MS;
	stmtUpsert.run(key, resetAt);
}

function clearAttempts(key: string): void {
	stmtDelete.run(key);
}

// Periodically clean stale entries (every 30 min)
setInterval(() => {
	try { stmtPrune.run(Date.now()); } catch { /* best effort */ }
}, 30 * 60 * 1000).unref();

/**
 * Check rate limits for a login attempt. Throws 429 if exceeded.
 * When email is omitted, only the IP-level limit is checked (pre-parse guard).
 */
export function checkLoginRateLimit(ip: string, email?: string): void {
	checkRateLimit('login_global', MAX_ATTEMPTS_GLOBAL, 'Too many login attempts');
	checkRateLimit(`ip:${ip}`, MAX_ATTEMPTS_IP, 'Too many login attempts');
	if (email) {
		checkRateLimit(`email:${email.toLowerCase()}`, MAX_ATTEMPTS_EMAIL, 'Too many login attempts');
	}
}

/**
 * Record a failed login attempt against IP, email, and global bucket.
 * The global bucket catches distributed attacks from rotating IPs.
 */
export function recordLoginFailure(ip: string, email: string): void {
	recordAttempt('login_global');
	recordAttempt(`ip:${ip}`);
	recordAttempt(`email:${email.toLowerCase()}`);
}

/**
 * Clear rate limit counters on successful login.
 */
export function clearLoginAttempts(ip: string, email: string): void {
	clearAttempts(`ip:${ip}`);
	clearAttempts(`email:${email.toLowerCase()}`);
}

/**
 * IP-only rate limit for the setup page (no email key yet).
 */
export function checkSetupRateLimit(ip: string): void {
	checkRateLimit(`setup:${ip}`, MAX_ATTEMPTS_IP, 'Too many setup attempts');
}

export function recordSetupFailure(ip: string): void {
	recordAttempt(`setup:${ip}`);
}

/**
 * Rate limit for email sending: max 20 emails per 15-minute window per user.
 * Prevents abuse of the SMTP relay through compromised sessions.
 */
const MAX_EMAILS = 20;

export function checkEmailRateLimit(userId: string): void {
	checkRateLimit(`email_send:${userId}`, MAX_EMAILS, 'Email rate limit exceeded');
}

export function recordEmailSend(userId: string): void {
	recordAttempt(`email_send:${userId}`);
}
