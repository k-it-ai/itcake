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

// AAD binds totp_secret ciphertext to its user row (enc3) — a DB writer
// who copies one user's blob into another row hits GCM tag failure.
function mfaAad(userId: string): string {
	return `users.totpSecret:${userId}`;
}

const stmtGetMfa = db.prepare(
	'SELECT password_hash, totp_secret, totp_enabled, totp_recovery_hashes FROM users WHERE id = ?'
);
const stmtSetMfa = db.prepare(
	'UPDATE users SET totp_secret = ?, totp_enabled = ?, totp_recovery_hashes = ? WHERE id = ?'
);
const stmtConsumeRecoveryCAS = db.prepare(
	'UPDATE users SET totp_recovery_hashes = ? WHERE id = ? AND totp_recovery_hashes = ?'
);
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
	} catch { /* corrupt → 0 */ }
	return { enabled: row.totp_enabled === 1, recoveryCodesRemaining: remaining };
}

interface MfaInitResult {
	secret: string;
	uri: string;
	qrDataUrl: string;
	recoveryCodes: string[];
}

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

// Persisting MFA state and revoking pre-MFA sessions MUST be atomic —
// a crash between them would leave MFA on with single-factor sessions
// alive, defeating the gate.
const enableMfaTx = db.transaction((userId: string, encryptedSecret: string, hashesJson: string): void => {
	stmtSetMfa.run(encryptedSecret, 1, hashesJson, userId);
	stmtDeleteUserSessions.run(userId);
	recordChange('settings', userId, 'update', { mfaEnabled: { old: false, new: true } }, userId);
});

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

const disableMfaTx = db.transaction((userId: string): void => {
	stmtSetMfa.run('', 0, '[]', userId);
	stmtDeleteUserSessions.run(userId);
	recordChange('settings', userId, 'update', { mfaEnabled: { old: true, new: false } }, userId);
});

export function verifyMfaCode(userId: string, code: string): boolean {
	const row = loadMfa(userId);
	if (!row || row.totp_enabled !== 1) return false;

	const secret = decryptField(row.totp_secret, mfaAad(userId));
	if (secret && totpVerify(secret, code)) return true;
	return stmtConsumeRecoveryTx(userId, code);
}

// Transactional CAS on the recovery-code array. Without this, two
// concurrent verifyMfaCode calls with the same code could both splice
// the same index and the second writer would resurrect codes the first
// splice removed (single-use guarantee broken).
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
	const result = stmtConsumeRecoveryCAS.run(JSON.stringify(hashes), userId, row.totp_recovery_hashes);
	return result.changes === 1;
});

export function isMfaEnabled(userId: string): boolean {
	const row = loadMfa(userId);
	return row?.totp_enabled === 1;
}
