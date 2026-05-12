import { db, generateId, createFirstUser, parseSqliteUtc } from './db.js';
import bcrypt from 'bcryptjs';
import crypto from 'node:crypto';
import type { Cookies } from '@sveltejs/kit';
import { env } from '$env/dynamic/private';
import { ServiceError } from '$lib/server/service-error.js';
import { hmacOrSha256 } from './crypto-helpers.js';

const SESSION_COOKIE = 'itcake_session';
const SESSION_MAX_AGE = 30 * 24 * 60 * 60;

interface SessionUser {
	id: string;
	email: string;
	name: string;
}

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
	return hmacOrSha256(SESSION_SECRET, token);
}

function setSessionCookie(cookies: Cookies, rawToken: string): void {
	cookies.set(SESSION_COOKIE, rawToken, {
		path: '/',
		httpOnly: true,
		sameSite: 'strict',
		secure: env.NODE_ENV !== 'development',
		maxAge: SESSION_MAX_AGE
	});
}

function rejectIfBcryptOverlong(password: string): void {
	if (Buffer.byteLength(password, 'utf-8') > 72) {
		throw new ServiceError('error.passwordTooLongForBcrypt');
	}
}

export async function createFirstUserSafe(email: string, name: string, password: string): Promise<string> {
	const id = generateId();
	rejectIfBcryptOverlong(password);
	const passwordHash = await bcrypt.hash(password, 12);
	const created = createFirstUser(id, email.toLowerCase(), name, passwordHash);
	if (!created) {
		throw new Error('REGISTRATION_CLOSED');
	}
	return id;
}

const DUMMY_HASH = '$2a$12$000000000000000000000uGByljMJlb63ZMliGhKROYRfkPheczOG';

const stmtGetUserByEmail = db.prepare('SELECT id, email, name, password_hash FROM users WHERE email = ?');
const stmtGetUserById = db.prepare('SELECT id, email, name FROM users WHERE id = ?');
const stmtInsertSession = db.prepare('INSERT INTO sessions (id, user_id, expires_at) VALUES (?, ?, ?)');
const stmtDeleteSession = db.prepare('DELETE FROM sessions WHERE id = ?');
const stmtDeleteUserSessions = db.prepare('DELETE FROM sessions WHERE user_id = ?');
const stmtHasUsers = db.prepare('SELECT COUNT(*) as count FROM users');
const stmtCleanExpiredSessions = db.prepare("DELETE FROM sessions WHERE datetime(expires_at) < datetime('now')");

export function getUserById(id: string): SessionUser | null {
	const user = stmtGetUserById.get(id) as SessionUser | undefined;
	return user ?? null;
}

export async function verifyPassword(email: string, password: string): Promise<SessionUser | null> {
	const user = stmtGetUserByEmail.get(email.toLowerCase()) as { id: string; email: string; name: string; password_hash: string } | undefined;
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
	createSessionTx(userId, hashedToken, expiresAt);
	setSessionCookie(cookies, rawToken);
	return rawToken;
}

const stmtGetSessionByHash = db.prepare(
	`SELECT s.id, s.user_id, s.expires_at, u.email, u.name FROM sessions s
	 JOIN users u ON u.id = s.user_id
	 WHERE s.id = ? AND datetime(s.expires_at) > datetime('now')`
);

const SESSION_EXTEND_THRESHOLD = 60 * 60;
const stmtRotateSession = db.prepare(
	'UPDATE sessions SET id = ?, expires_at = ? WHERE id = ?'
);

export function getSession(cookies: Cookies): SessionUser | null {
	const rawToken = cookies.get(SESSION_COOKIE);
	if (!rawToken) return null;

	if (!/^[0-9a-f]{64}$/.test(rawToken)) return null;

	// hashSessionToken is HMAC-SHA256 keyed by SESSION_SECRET. Looking the row
	// up by its hash is timing-safe: an attacker cannot influence the hash
	// without knowing the secret, so the SQL B-tree path leak does not
	// translate into a token-recovery oracle.
	const hashedToken = hashSessionToken(rawToken);
	const matched = stmtGetSessionByHash.get(hashedToken) as
		| { id: string; user_id: string; expires_at: string; email: string; name: string }
		| undefined;
	if (!matched) return null;

	const expiresAtMs = parseSqliteUtc(matched.expires_at);
	const remainingSec = (expiresAtMs - Date.now()) / 1000;
	if (remainingSec <= 0) {
		stmtDeleteSession.run(matched.id);
		cookies.delete(SESSION_COOKIE, { path: '/' });
		return null;
	}
	if (remainingSec < SESSION_MAX_AGE - SESSION_EXTEND_THRESHOLD) {
		const newRawToken = crypto.randomBytes(32).toString('hex');
		const newHashedToken = hashSessionToken(newRawToken);
		const newExpiry = new Date(Date.now() + SESSION_MAX_AGE * 1000).toISOString();
		const result = stmtRotateSession.run(newHashedToken, newExpiry, matched.id);
		if (result.changes === 1) {
			setSessionCookie(cookies, newRawToken);
		} else {
			// concurrent request rotated first → fail closed
			cookies.delete(SESSION_COOKIE, { path: '/' });
			return null;
		}
	}

	return { id: matched.user_id, email: matched.email, name: matched.name };
}

export function isSessionTokenValid(rawToken: string): boolean {
	if (!/^[0-9a-f]{64}$/.test(rawToken)) return false;
	const row = stmtGetSessionByHash.get(hashSessionToken(rawToken)) as { id: string } | undefined;
	return !!row;
}

export function deleteSession(cookies: Cookies): void {
	const rawToken = cookies.get(SESSION_COOKIE);
	if (rawToken) {
		stmtDeleteSession.run(hashSessionToken(rawToken));
	}
	cookies.delete(SESSION_COOKIE, { path: '/' });
}

const stmtUpdatePassword = db.prepare('UPDATE users SET password_hash = ? WHERE id = ?');

// Pair the password hash update + session revocation in one transaction so
// a power-loss / OOM-kill between the two statements can't leave a freshly
// changed-password account with stale session rows still usable for the
// next 30 days. CLAUDE.md §Security-model-invariants states "password
// change revoke all sessions in-transaction" — this is that invariant.
// bcrypt is async so we run it OUTSIDE the transaction and commit only the
// two sync writes inside.
const updatePasswordAndRevokeSessions = db.transaction((userId: string, newHash: string): void => {
	stmtUpdatePassword.run(newHash, userId);
	stmtDeleteUserSessions.run(userId);
});

export async function verifyUserPassword(userId: string, password: string): Promise<boolean> {
	const user = db.prepare('SELECT password_hash FROM users WHERE id = ?').get(userId) as { password_hash: string } | undefined;
	return bcrypt.compare(password, user?.password_hash ?? DUMMY_HASH);
}

export async function changePassword(userId: string, currentPassword: string, newPassword: string): Promise<void> {
	const user = db.prepare('SELECT password_hash FROM users WHERE id = ?').get(userId) as { password_hash: string } | undefined;
	if (!user) throw new Error('User not found');

	const valid = await bcrypt.compare(currentPassword, user.password_hash);
	if (!valid) throw new ServiceError('error.currentPasswordIncorrect');

	rejectIfBcryptOverlong(newPassword);
	const newHash = await bcrypt.hash(newPassword, 12);
	updatePasswordAndRevokeSessions(userId, newHash);
}

export function hasUsers(): boolean {
	const row = stmtHasUsers.get() as { count: number };
	return row.count > 0;
}

export function cleanExpiredSessions(): void {
	stmtCleanExpiredSessions.run();
}
