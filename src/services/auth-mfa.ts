import { db } from '$lib/server/db.js';
import { encryptField, decryptField } from '$lib/server/field-crypto.js';

// AAD binds the encrypted TOTP secret to a specific user row (enc3 format).
// A DB writer who copies one user's totp_secret ciphertext into another
// user's row sees GCM tag verification fail at the destination — the same
// defense pattern agents.hmacSecret and agents.remoteDesktop.{password,
// privateKey} already use. v2 ciphertexts written before this change still
// decrypt because decryptField ignores AAD on v2; new writes go v3.
function mfaAad(userId: string): string {
	return `users.totpSecret:${userId}`;
}
import { recordChange } from '$lib/server/changes.js';
import { ServiceError } from '$lib/server/service-error.js';
import { generateQrCodeDataUrl } from '$lib/server/qr-code.js';
import {
	generateTotpSecret,
	generateRecoveryCodes,
	hashRecoveryCode,
	totpVerify,
	totpUri,
	RECOVERY_CODE_COUNT
} from '$lib/server/totp.js';
import bcrypt from 'bcryptjs';

const stmtGetMfa = db.prepare(
	'SELECT password_hash, totp_secret, totp_enabled, totp_recovery_hashes FROM users WHERE id = ?'
);
const stmtSetMfa = db.prepare(
	'UPDATE users SET totp_secret = ?, totp_enabled = ?, totp_recovery_hashes = ? WHERE id = ?'
);
// Optimistic CAS: writes the new hashes JSON only when the row's current
// value still matches the snapshot the caller read. See `stmtConsumeRecoveryTx`
// for the load+check+splice+write race that this guards.
const stmtConsumeRecoveryCAS = db.prepare(
	'UPDATE users SET totp_recovery_hashes = ? WHERE id = ? AND totp_recovery_hashes = ?'
);
// Used to revoke all sessions on MFA state change so a session captured
// before MFA was enabled (or while it was off) can't ride past the gate.
const stmtDeleteUserSessions = db.prepare('DELETE FROM sessions WHERE user_id = ?');

type MfaRow = {
	password_hash: string;
	totp_secret: string;
	totp_enabled: number;
	totp_recovery_hashes: string;
};

interface MfaStatus {
	enabled: boolean;
	recoveryCodesRemaining: number;
}

function loadMfa(userId: string): MfaRow | null {
	const row = stmtGetMfa.get(userId) as MfaRow | undefined;
	return row ?? null;
}

export function getMfaStatus(userId: string): MfaStatus {
	const row = loadMfa(userId);
	if (!row) return { enabled: false, recoveryCodesRemaining: 0 };
	let remaining = 0;
	try {
		const arr = JSON.parse(row.totp_recovery_hashes) as string[];
		if (Array.isArray(arr)) remaining = arr.length;
	} catch { /* corrupt → treat as 0 */ }
	return { enabled: row.totp_enabled === 1, recoveryCodesRemaining: remaining };
}

interface MfaInitResult {
	secret: string;
	uri: string;
	qrDataUrl: string;
	recoveryCodes: string[];
}

/**
 * Begin enrollment: generate a fresh secret + recovery codes and return
 * them once. Nothing is persisted yet — the caller must call enableMfa()
 * with the secret + a valid TOTP code from the user's authenticator to
 * commit. This avoids a half-enabled state where the secret is on disk
 * but the user can't actually use it.
 */
export function initMfa(userEmail: string, issuer = 'ITCake'): MfaInitResult {
	const secret = generateTotpSecret();
	const recoveryCodes = generateRecoveryCodes();
	const uri = totpUri(userEmail, issuer, secret);
	return {
		secret,
		uri,
		qrDataUrl: generateQrCodeDataUrl(uri),
		recoveryCodes
	};
}

/**
 * Confirm enrollment by verifying a TOTP code against the proposed secret.
 * On success, persist the encrypted secret + hashed recovery codes and
 * mark MFA enabled. Throws ServiceError on bad code or already-enabled.
 */
export function enableMfa(
	userId: string,
	secret: string,
	code: string,
	recoveryCodes: string[]
): void {
	const row = loadMfa(userId);
	if (!row) throw new Error('User not found');
	if (row.totp_enabled === 1) throw new ServiceError('error.mfaAlreadyEnabled');
	if (!totpVerify(secret, code)) throw new ServiceError('error.mfaCodeInvalid');
	if (!Array.isArray(recoveryCodes) || recoveryCodes.length !== RECOVERY_CODE_COUNT) {
		throw new ServiceError('error.mfaRecoveryCodesInvalid');
	}
	const encryptedSecret = encryptField(secret, mfaAad(userId));
	const hashes = recoveryCodes.map(hashRecoveryCode);
	enableMfaTx(userId, encryptedSecret, JSON.stringify(hashes));
}

// Atomic: persisting the MFA state and revoking pre-MFA sessions must
// happen together. If they're separate statements, a crash between
// them leaves MFA flipped on while stale single-factor sessions
// survive — exactly the attack the revocation is meant to prevent.
const enableMfaTx = db.transaction((userId: string, encryptedSecret: string, hashesJson: string): void => {
	stmtSetMfa.run(encryptedSecret, 1, hashesJson, userId);
	// Revoke all active sessions: a session captured before MFA was on
	// is still single-factor and would otherwise sail past the new
	// gate. The caller MUST also clear the request's cookie so the
	// operator re-authenticates with the second factor.
	stmtDeleteUserSessions.run(userId);
	recordChange('settings', userId, 'update', { mfaEnabled: { old: false, new: true } }, userId);
});

/**
 * Disable MFA. Requires both the current password (proves session
 * identity owner, not just session theft) AND a valid TOTP code or
 * recovery code (proves possession of the second factor).
 */
export async function disableMfa(
	userId: string,
	currentPassword: string,
	codeOrRecovery: string
): Promise<void> {
	const row = loadMfa(userId);
	if (!row) throw new Error('User not found');
	if (row.totp_enabled !== 1) throw new ServiceError('error.mfaNotEnabled');

	const validPassword = await bcrypt.compare(currentPassword, row.password_hash);
	if (!validPassword) throw new ServiceError('error.currentPasswordIncorrect');

	const secret = decryptField(row.totp_secret, mfaAad(userId));
	const totpOk = secret && totpVerify(secret, codeOrRecovery);
	const recoveryOk = !totpOk && stmtConsumeRecoveryTx(userId, codeOrRecovery);
	if (!totpOk && !recoveryOk) throw new ServiceError('error.mfaCodeInvalid');

	disableMfaTx(userId);
}

// Atomic counterpart to enableMfaTx — same rationale: clearing the
// secret and revoking sessions must be one indivisible step.
const disableMfaTx = db.transaction((userId: string): void => {
	stmtSetMfa.run('', 0, '[]', userId);
	// Revoke all active sessions so a stolen-cookie attacker who learned
	// the password but not the second factor can't keep riding the
	// pre-disable session after the legitimate operator turns MFA off.
	// The caller MUST also clear the request's cookie.
	stmtDeleteUserSessions.run(userId);
	recordChange('settings', userId, 'update', { mfaEnabled: { old: true, new: false } }, userId);
});

/**
 * Verify a TOTP code (or recovery code) for an authenticated MFA challenge.
 * Returns true on match. Recovery codes are consumed (single-use).
 */
export function verifyMfaCode(userId: string, code: string): boolean {
	const row = loadMfa(userId);
	if (!row || row.totp_enabled !== 1) return false;

	const secret = decryptField(row.totp_secret, mfaAad(userId));
	if (secret && totpVerify(secret, code)) return true;
	return stmtConsumeRecoveryTx(userId, code);
}

// Atomic compare-and-swap for the recovery-code array. Without this
// wrapper, two concurrent verifyMfaCode calls with the same code can
// both load the same JSON snapshot, both find their target index, both
// splice, and both write — same code consumed twice + unrelated codes
// resurrected (whichever splice writes second wins, dropping the first
// splice's removal). Wrapping load + check + splice + write in one
// db.transaction (which better-sqlite3 serializes synchronously)
// closes the race. The optimistic `WHERE` clause defends against
// any future async rewrite of the function.
const stmtConsumeRecoveryTx = db.transaction((userId: string, code: string): boolean => {
	const row = stmtGetMfa.get(userId) as MfaRow | undefined;
	if (!row) return false;
	let hashes: string[];
	try {
		hashes = JSON.parse(row.totp_recovery_hashes);
		if (!Array.isArray(hashes)) return false;
	} catch {
		return false;
	}
	const hash = hashRecoveryCode(code);
	const idx = hashes.indexOf(hash);
	if (idx < 0) return false;
	hashes.splice(idx, 1);
	// Only commit if the row's snapshot is still what we read (defends
	// against a concurrent writer beating us); on miss return false so
	// the caller does not credit the user with a code they may not have
	// actually consumed.
	const result = stmtConsumeRecoveryCAS.run(JSON.stringify(hashes), userId, row.totp_recovery_hashes);
	return result.changes === 1;
});

export function isMfaEnabled(userId: string): boolean {
	const row = loadMfa(userId);
	return row?.totp_enabled === 1;
}
