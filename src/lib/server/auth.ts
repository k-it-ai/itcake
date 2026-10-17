import { db, generateId, createFirstUser, parseSqliteUtc } from './db.js';
import bcrypt from 'bcryptjs';
import crypto from 'node:crypto';
import type { Cookies } from '@sveltejs/kit';
import { NODE_ENV, SESSION_SECRET as SESSION_SECRET_ENV } from '$app/env/private';
import { ServiceError } from '#lib/server/service-error.js';
import { hmacOrSha256 } from './crypto-helpers.js';
import { recordChange } from './changes.js';

const SESSION_COOKIE = 'itcake_session';
const SESSION_MAX_AGE = 30 * 24 * 60 * 60;

export type UserRole = 'admin' | 'user';

interface SessionUser {
	id: string;
	email: string;
	name: string;
	role: UserRole;
}

const SESSION_SECRET = SESSION_SECRET_ENV || '';
if (!SESSION_SECRET) {
	if (NODE_ENV === 'development') {
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
		secure: NODE_ENV !== 'development',
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

const stmtGetUserByEmail = db.prepare('SELECT id, email, name, password_hash, role FROM users WHERE email = ?');
const stmtInsertSession = db.prepare('INSERT INTO sessions (id, user_id, expires_at) VALUES (?, ?, ?)');
const stmtDeleteSession = db.prepare('DELETE FROM sessions WHERE id = ?');
const stmtDeleteUserSessions = db.prepare('DELETE FROM sessions WHERE user_id = ?');
const stmtHasUsers = db.prepare('SELECT COUNT(*) as count FROM users');
const stmtCleanExpiredSessions = db.prepare("DELETE FROM sessions WHERE datetime(expires_at) < datetime('now')");

export async function verifyPassword(email: string, password: string): Promise<SessionUser | null> {
	// bcrypt silently truncates input >72 bytes. Registration rejects
	// such passwords via `rejectIfBcryptOverlong`, so any stored hash
	// was made from ≤72-byte input. On login, an attacker who knows the
	// real password could otherwise append arbitrary trailing bytes and
	// still match (the suffix would be truncated away). Reject here
	// before reaching bcrypt to close that bypass without depending on
	// the validator chain at the route layer.
	if (Buffer.byteLength(password, 'utf-8') > 72) {
		// Still run a constant-time compare against the dummy hash so the
		// timing matches the "user not found" path — otherwise this is a
		// trivial oracle for "this email is registered with a normal-length
		// password" vs "with no password" (which can't happen, but we want
		// the path indistinguishable from the not-found case).
		await bcrypt.compare(password.slice(0, 100), DUMMY_HASH);
		return null;
	}
	const user = stmtGetUserByEmail.get(email.toLowerCase()) as { id: string; email: string; name: string; password_hash: string; role: string } | undefined;
	const valid = await bcrypt.compare(password, user?.password_hash ?? DUMMY_HASH);
	if (!user || !valid) return null;
	const role: UserRole = user.role === 'user' ? 'user' : 'admin';
	return { id: user.id, email: user.email, name: user.name, role };
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
	`SELECT s.id, s.user_id, s.expires_at, u.email, u.name, u.role FROM sessions s
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

	const hashedToken = hashSessionToken(rawToken);
	const matched = stmtGetSessionByHash.get(hashedToken) as
		| { id: string; user_id: string; expires_at: string; email: string; name: string; role: string }
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
			cookies.delete(SESSION_COOKIE, { path: '/' });
			return null;
		}
	}

	const role: UserRole = matched.role === 'user' ? 'user' : 'admin';
	return { id: matched.user_id, email: matched.email, name: matched.name, role };
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

const updatePasswordAndRevokeSessions = db.transaction((userId: string, newHash: string): void => {
	stmtUpdatePassword.run(newHash, userId);
	stmtDeleteUserSessions.run(userId);
	recordChange('settings', 'password', 'update', { password: { old: '[changed]', new: '[changed]' } }, userId);
});

export async function verifyUserPassword(userId: string, password: string): Promise<boolean> {
	// Same bcrypt-truncation gate as `verifyPassword`. This helper is the
	// step-up password check used by `/api/auth/password`, MFA disable,
	// and the MFA init flow — all of which must reject any input that
	// would land in bcrypt as a truncated suffix-match.
	if (Buffer.byteLength(password, 'utf-8') > 72) {
		await bcrypt.compare(password.slice(0, 100), DUMMY_HASH);
		return false;
	}
	const user = db.prepare('SELECT password_hash FROM users WHERE id = ?').get(userId) as { password_hash: string } | undefined;
	return bcrypt.compare(password, user?.password_hash ?? DUMMY_HASH);
}

export async function changePassword(userId: string, currentPassword: string, newPassword: string): Promise<void> {
	const user = db.prepare('SELECT password_hash FROM users WHERE id = ?').get(userId) as { password_hash: string } | undefined;
	if (!user) throw new Error('User not found');

	// `currentPassword` must go through the same byte-length gate as
	// `verifyPassword` — otherwise an attacker who knows the real password
	// could pass `realPass + 100 trailing bytes` and bcrypt would silently
	// truncate the suffix away (registration caps at 72 bytes, so the real
	// password is always a 72-byte prefix-match candidate).
	if (Buffer.byteLength(currentPassword, 'utf-8') > 72) {
		throw new ServiceError('error.currentPasswordIncorrect');
	}
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
