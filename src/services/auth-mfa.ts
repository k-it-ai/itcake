import { db } from '$lib/server/db.js';
import { encryptField, decryptField } from '$lib/server/field-crypto.js';
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
const stmtUpdateRecovery = db.prepare(
	'UPDATE users SET totp_recovery_hashes = ? WHERE id = ?'
);

type MfaRow = {
	password_hash: string;
	totp_secret: string;
	totp_enabled: number;
	totp_recovery_hashes: string;
};

export interface MfaStatus {
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

export interface MfaInitResult {
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
	const encryptedSecret = encryptField(secret);
	const hashes = recoveryCodes.map(hashRecoveryCode);
	stmtSetMfa.run(encryptedSecret, 1, JSON.stringify(hashes), userId);
	recordChange('settings', userId, 'update', { mfaEnabled: { old: false, new: true } }, userId);
}

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

	const secret = decryptField(row.totp_secret);
	const totpOk = secret && totpVerify(secret, codeOrRecovery);
	const recoveryOk = !totpOk && consumeRecoveryCode(userId, row, codeOrRecovery);
	if (!totpOk && !recoveryOk) throw new ServiceError('error.mfaCodeInvalid');

	stmtSetMfa.run('', 0, '[]', userId);
	recordChange('settings', userId, 'update', { mfaEnabled: { old: true, new: false } }, userId);
}

/**
 * Verify a TOTP code (or recovery code) for an authenticated MFA challenge.
 * Returns true on match. Recovery codes are consumed (single-use).
 */
export function verifyMfaCode(userId: string, code: string): boolean {
	const row = loadMfa(userId);
	if (!row || row.totp_enabled !== 1) return false;

	const secret = decryptField(row.totp_secret);
	if (secret && totpVerify(secret, code)) return true;
	return consumeRecoveryCode(userId, row, code);
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
	// Optimistic-version guard: only update when the snapshot we read is
	// still the current value (no concurrent writer beat us). On miss,
	// return false so the caller does not credit the user with a code
	// they may not have actually consumed.
	const stmt = db.prepare('UPDATE users SET totp_recovery_hashes = ? WHERE id = ? AND totp_recovery_hashes = ?');
	const result = stmt.run(JSON.stringify(hashes), userId, row.totp_recovery_hashes);
	return result.changes === 1;
});

function consumeRecoveryCode(userId: string, _row: MfaRow, code: string): boolean {
	// `_row` is unused — we re-read inside the transaction for atomicity.
	return stmtConsumeRecoveryTx(userId, code);
}

export function isMfaEnabled(userId: string): boolean {
	const row = loadMfa(userId);
	return row?.totp_enabled === 1;
}
