import crypto from 'node:crypto';
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

const enableMfaTx = db.transaction((userId: string, encryptedSecret: string, hashesJson: string): void => {
	stmtSetMfa.run(encryptedSecret, 1, hashesJson, userId);
	stmtDeleteUserSessions.run(userId);
	recordChange('settings', userId, 'update', { mfaEnabled: { old: false, new: true } }, userId);
});

// Caller verifies password + step-up before this. Only does the teardown.
export const disableMfa = db.transaction((userId: string): void => {
	const current = stmtGetMfa.get(userId) as MfaRow | undefined;
	if (!current || current.totp_enabled !== 1) throw new ServiceError('error.mfaNotEnabled');
	stmtSetMfa.run('', 0, '[]', userId);
	stmtDeleteUserSessions.run(userId);
	recordChange('settings', userId, 'update', { mfaEnabled: { old: true, new: false } }, userId);
});

export type MfaCodeKind = 'totp' | 'recovery' | null;

export function verifyMfaCode(userId: string, code: string): MfaCodeKind {
	const row = loadMfa(userId);
	if (!row || row.totp_enabled !== 1) return null;

	const secret = decryptField(row.totp_secret, mfaAad(userId));
	const totpOk = !!secret && totpVerify(secret, code);
	const recoveryOk = matchesRecoveryCode(row.totp_recovery_hashes, code);
	if (totpOk) return 'totp';
	if (recoveryOk) return 'recovery';
	return null;
}

export function consumeRecoveryCode(userId: string, code: string): boolean {
	return stmtConsumeRecoveryTx(userId, code);
}

function matchesRecoveryCode(hashesJson: string, code: string): boolean {
	let hashes: string[];
	try {
		hashes = JSON.parse(hashesJson);
		if (!Array.isArray(hashes)) return false;
	} catch {
		return false;
	}
	const hash = hashRecoveryCode(code);
	const target = Buffer.from(hash, 'hex');
	let matched = false;
	for (const h of hashes) {
		const candidate = Buffer.from(h, 'hex');
		if (candidate.length === target.length && crypto.timingSafeEqual(candidate, target)) {
			matched = true;
		}
	}
	return matched;
}

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
	const target = Buffer.from(hash, 'hex');
	let matchIdx = -1;
	for (let i = 0; i < hashes.length; i++) {
		const candidate = Buffer.from(hashes[i], 'hex');
		if (candidate.length === target.length && crypto.timingSafeEqual(candidate, target)) {
			matchIdx = i; // don't break — keep work proportional to hashes.length
		}
	}
	if (matchIdx < 0) return false;
	hashes.splice(matchIdx, 1);
	const result = stmtConsumeRecoveryCAS.run(JSON.stringify(hashes), userId, row.totp_recovery_hashes);
	return result.changes === 1;
});

export function isMfaEnabled(userId: string): boolean {
	const row = loadMfa(userId);
	return row?.totp_enabled === 1;
}
