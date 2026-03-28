import { db, generateId, createFirstUser } from './db.js';
import bcrypt from 'bcryptjs';
import crypto from 'node:crypto';
import type { Cookies } from '@sveltejs/kit';
import { env } from '$env/dynamic/private';
import { ServiceError } from '$lib/server/service-error.js';

const SESSION_COOKIE = 'itcake_session';
const SESSION_MAX_AGE = 30 * 24 * 60 * 60; // 30 days in seconds

interface SessionUser {
	id: string;
	email: string;
	name: string;
}

/**
 * Hash a session token for storage using HMAC-SHA256.
 * The raw token is sent to the client; the HMAC is stored in the database.
 * If the DB is leaked without the secret, session tokens cannot be verified.
 *
 * Falls back to plain SHA-256 when SESSION_SECRET is not set (backward compat
 * with existing sessions). New deployments should always set SESSION_SECRET.
 */
const SESSION_SECRET = env.SESSION_SECRET || '';
if (!SESSION_SECRET) {
	if (env.NODE_ENV === 'development') {
		console.warn('[auth] SESSION_SECRET not set — using plain SHA256 for session tokens (development only)');
	} else {
		throw new Error(
			'SESSION_SECRET is required in production. ' +
			'Generate one with: node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'hex\'))" ' +
			'and add it to your .env file.'
		);
	}
} else if (SESSION_SECRET.length < 32) {
	throw new Error(
		'SESSION_SECRET must be at least 32 characters. ' +
		'Generate one with: node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'hex\'))"'
	);
}
function hashSessionToken(token: string): string {
	if (SESSION_SECRET) {
		return crypto.createHmac('sha256', SESSION_SECRET).update(token).digest('hex');
	}
	return crypto.createHash('sha256').update(token).digest('hex');
}

/**
 * Atomically create the first user. Returns the user ID, or throws if a user already exists.
 * This is the only user creation path — no unguarded createUser is exported.
 */
export async function createFirstUserSafe(email: string, name: string, password: string): Promise<string> {
	const id = generateId();
	const passwordHash = await bcrypt.hash(password, 12);
	const created = createFirstUser(id, email.toLowerCase(), name, passwordHash);
	if (!created) {
		throw new Error('REGISTRATION_CLOSED');
	}
	return id;
}

// Dummy hash for constant-time comparison when user not found
const DUMMY_HASH = '$2a$12$000000000000000000000uGByljMJlb63ZMliGhKROYRfkPheczOG';

const stmtGetUserByEmail = db.prepare('SELECT id, email, name, password_hash FROM users WHERE email = ?');
const stmtInsertSession = db.prepare('INSERT INTO sessions (id, user_id, expires_at) VALUES (?, ?, ?)');
const stmtDeleteSession = db.prepare('DELETE FROM sessions WHERE id = ?');
const stmtDeleteUserSessions = db.prepare('DELETE FROM sessions WHERE user_id = ?');
const stmtHasUsers = db.prepare('SELECT COUNT(*) as count FROM users');
const stmtCleanExpiredSessions = db.prepare("DELETE FROM sessions WHERE expires_at < datetime('now')");

export async function verifyPassword(email: string, password: string): Promise<SessionUser | null> {
	const user = stmtGetUserByEmail.get(email.toLowerCase()) as { id: string; email: string; name: string; password_hash: string } | undefined;

	// Always run bcrypt.compare to prevent timing-based username enumeration
	const valid = await bcrypt.compare(password, user?.password_hash ?? DUMMY_HASH);
	if (!user || !valid) return null;

	return { id: user.id, email: user.email, name: user.name };
}

const createSessionTx = db.transaction((userId: string, hashedToken: string, expiresAt: string) => {
	stmtDeleteUserSessions.run(userId);
	stmtInsertSession.run(hashedToken, userId, expiresAt);
});

export function createSession(userId: string, cookies: Cookies): string {
	const rawToken = crypto.randomBytes(32).toString('hex');
	const hashedToken = hashSessionToken(rawToken);
	const expiresAt = new Date(Date.now() + SESSION_MAX_AGE * 1000).toISOString();

	// Atomic: delete old sessions + insert new one in a single transaction
	createSessionTx(userId, hashedToken, expiresAt);

	cookies.set(SESSION_COOKIE, rawToken, {
		path: '/',
		httpOnly: true,
		sameSite: 'strict',
		secure: env.NODE_ENV !== 'development',
		maxAge: SESSION_MAX_AGE
	});

	return rawToken;
}

// Fetch all active sessions for timing-safe comparison in JS (single-user app has at most 1)
const stmtGetActiveSessions = db.prepare(
	`SELECT s.id, s.user_id, s.expires_at, u.email, u.name FROM sessions s
	 JOIN users u ON u.id = s.user_id
	 WHERE s.expires_at > datetime('now')`
);

const SESSION_EXTEND_THRESHOLD = 60 * 60;
const stmtExtendSession = db.prepare("UPDATE sessions SET expires_at = ? WHERE id = ?");

export function getSession(cookies: Cookies): SessionUser | null {
	const rawToken = cookies.get(SESSION_COOKIE);
	if (!rawToken) return null;

	if (!/^[0-9a-f]{64}$/.test(rawToken)) return null;

	const hashedToken = hashSessionToken(rawToken);
	const hashedBuf = Buffer.from(hashedToken, 'hex');

	// Constant-time comparison: iterate all active sessions (at most 1 due to single-session enforcement)
	const rows = stmtGetActiveSessions.all() as { id: string; user_id: string; expires_at: string; email: string; name: string }[];
	let matched: typeof rows[0] | null = null;
	for (const row of rows) {
		const storedBuf = Buffer.from(row.id, 'hex');
		if (storedBuf.length === hashedBuf.length && crypto.timingSafeEqual(storedBuf, hashedBuf)) {
			matched = row;
		}
	}

	if (!matched) return null;

	// Sliding window extension
	const expiresAtMs = new Date(matched.expires_at.endsWith('Z') ? matched.expires_at : matched.expires_at + 'Z').getTime();
	const remainingSec = (expiresAtMs - Date.now()) / 1000;
	if (remainingSec < SESSION_MAX_AGE - SESSION_EXTEND_THRESHOLD) {
		const newExpiry = new Date(Date.now() + SESSION_MAX_AGE * 1000).toISOString();
		stmtExtendSession.run(newExpiry, matched.id);
		cookies.set(SESSION_COOKIE, rawToken, {
			path: '/',
			httpOnly: true,
			sameSite: 'strict',
			secure: env.NODE_ENV !== 'development',
			maxAge: SESSION_MAX_AGE
		});
	}

	return { id: matched.user_id, email: matched.email, name: matched.name };
}

export function isSessionTokenValid(rawToken: string): boolean {
	if (!/^[0-9a-f]{64}$/.test(rawToken)) return false;
	const hashedBuf = Buffer.from(hashSessionToken(rawToken), 'hex');
	const rows = stmtGetActiveSessions.all() as { id: string }[];
	for (const row of rows) {
		const storedBuf = Buffer.from(row.id, 'hex');
		if (storedBuf.length === hashedBuf.length && crypto.timingSafeEqual(storedBuf, hashedBuf)) {
			return true;
		}
	}
	return false;
}

export function deleteSession(cookies: Cookies): void {
	const rawToken = cookies.get(SESSION_COOKIE);
	if (rawToken) {
		stmtDeleteSession.run(hashSessionToken(rawToken));
	}
	cookies.delete(SESSION_COOKIE, { path: '/' });
}

const stmtUpdatePassword = db.prepare('UPDATE users SET password_hash = ? WHERE id = ?');

export async function changePassword(userId: string, currentPassword: string, newPassword: string): Promise<void> {
	const user = db.prepare('SELECT password_hash FROM users WHERE id = ?').get(userId) as { password_hash: string } | undefined;
	if (!user) throw new Error('User not found');

	const valid = await bcrypt.compare(currentPassword, user.password_hash);
	if (!valid) throw new ServiceError('error.currentPasswordIncorrect');

	const newHash = await bcrypt.hash(newPassword.slice(0, 72), 12);
	stmtUpdatePassword.run(newHash, userId);
	stmtDeleteUserSessions.run(userId);
}

export function hasUsers(): boolean {
	const row = stmtHasUsers.get() as { count: number };
	return row.count > 0;
}

// Clean up expired sessions periodically
export function cleanExpiredSessions(): void {
	stmtCleanExpiredSessions.run();
}
