#!/usr/bin/env node
/**
 * Re-wraps every enc3: ciphertext in the ITCake DB from the OLD
 * SESSION_SECRET to a NEW one. Must run with the service stopped.
 *
 * Usage:
 *   node scripts/rotate-session-secret.mjs \
 *     --db data/itcake.db \
 *     --old <hex32> \
 *     --new <hex32> \
 *     [--dry-run]
 *
 * What it touches:
 *   - settings: every credential in src/lib/server/settings-credentials.js
 *     (the exhaustive list lives there)
 *   - agents: hmac_secret column + data.remoteDesktop.{password,privateKey}
 *   - users: totp_secret column
 *
 * Safety:
 *   - Pre-flight: verifies --old actually decrypts the first enc3: blob in
 *     the DB before anything is written. Aborts with exit 2 otherwise.
 *   - Atomic: all re-wraps + row clears run in a single SQLite transaction.
 *     Any per-field failure rolls the whole thing back and exits 1 — the DB
 *     is never left half-rotated.
 *   - --dry-run reports what would change without writing.
 *
 * What it does NOT touch (operator must handle manually):
 *   - TOTP recovery code hashes — HMACs, not reversible. Regenerate codes.
 *   - mfa_used_challenges + mfa_step_up_used_codes + sessions — cleared.
 *   - Audit log per-row HMACs — boot-time recomputeAuditAnchor() will
 *     re-anchor; verifier will treat pre-rotation rows as unverified.
 *     Export to file BEFORE rotation if you want a verifiable archive.
 *
 * KDF parameters are imported from src/lib/server/field-crypto-params.js —
 * the exact module the app uses — so they cannot drift from the app.
 */
import Database from 'better-sqlite3';
import crypto from 'node:crypto';
import { parseArgs } from 'node:util';
import fs from 'node:fs';
import {
	FIELD_ALGORITHM,
	FIELD_KEY_INFO,
	IV_LENGTH,
	KEY_LENGTH,
	MASTER_KEY_SALT,
	MASTER_KEY_SCRYPT_OPTS,
	SALT_LENGTH,
	TAG_LENGTH
} from '../src/lib/server/field-crypto-params.js';
import { SETTINGS_CREDENTIALS } from '../src/lib/server/settings-credentials.js';

const PREFIX_V3 = 'enc3:';

/**
 * @param {string} secret
 * @returns {Buffer}
 */
function deriveMasterKey(secret) {
	return crypto.scryptSync(secret, MASTER_KEY_SALT, KEY_LENGTH, MASTER_KEY_SCRYPT_OPTS);
}

/**
 * @param {Buffer} masterKey
 * @param {Buffer} salt
 * @returns {Buffer}
 */
function deriveFieldKey(masterKey, salt) {
	return Buffer.from(crypto.hkdfSync('sha256', masterKey, salt, FIELD_KEY_INFO, KEY_LENGTH));
}

/**
 * @param {string} ct
 * @param {Buffer} masterKey
 * @param {string} aad
 * @returns {string}
 */
function decryptEnc3(ct, masterKey, aad) {
	if (!ct.startsWith(PREFIX_V3)) throw new Error('not enc3:');
	const buf = Buffer.from(ct.slice(PREFIX_V3.length), 'base64');
	const salt = buf.subarray(0, SALT_LENGTH);
	const iv = buf.subarray(SALT_LENGTH, SALT_LENGTH + IV_LENGTH);
	const tag = buf.subarray(SALT_LENGTH + IV_LENGTH, SALT_LENGTH + IV_LENGTH + TAG_LENGTH);
	const enc = buf.subarray(SALT_LENGTH + IV_LENGTH + TAG_LENGTH);
	const key = deriveFieldKey(masterKey, salt);
	const decipher = crypto.createDecipheriv(FIELD_ALGORITHM, key, iv);
	decipher.setAuthTag(tag);
	if (aad) decipher.setAAD(Buffer.from(aad, 'utf-8'));
	return Buffer.concat([decipher.update(enc), decipher.final()]).toString('utf-8');
}

/**
 * @param {string} plain
 * @param {Buffer} masterKey
 * @param {string} aad
 * @returns {string}
 */
function encryptEnc3(plain, masterKey, aad) {
	const salt = crypto.randomBytes(SALT_LENGTH);
	const iv = crypto.randomBytes(IV_LENGTH);
	const key = deriveFieldKey(masterKey, salt);
	const cipher = crypto.createCipheriv(FIELD_ALGORITHM, key, iv);
	if (aad) cipher.setAAD(Buffer.from(aad, 'utf-8'));
	const enc = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
	const tag = cipher.getAuthTag();
	return PREFIX_V3 + Buffer.concat([salt, iv, tag, enc]).toString('base64');
}

/**
 * @param {string | null | undefined} ct
 * @param {Buffer} oldKey
 * @param {Buffer} newKey
 * @param {string} aad
 * @returns {string | null}
 */
function rewrap(ct, oldKey, newKey, aad) {
	if (!ct || typeof ct !== 'string' || !ct.startsWith(PREFIX_V3)) return null;
	const plain = decryptEnc3(ct, oldKey, aad);
	return encryptEnc3(plain, newKey, aad);
}

/**
 * @param {unknown} obj
 * @param {string[]} p
 * @returns {unknown}
 */
function getPath(obj, p) {
	/** @type {any} */
	let cur = obj;
	for (const k of p) { if (cur == null) return undefined; cur = cur[k]; }
	return cur;
}

/**
 * @param {Record<string, any>} obj
 * @param {string[]} p
 * @param {unknown} v
 */
function setPath(obj, p, v) {
	/** @type {any} */
	let cur = obj;
	for (let i = 0; i < p.length - 1; i++) { if (cur[p[i]] == null) cur[p[i]] = {}; cur = cur[p[i]]; }
	cur[p[p.length - 1]] = v;
}

/**
 * @param {unknown} e
 * @returns {string}
 */
function errMsg(e) {
	return e instanceof Error ? e.message : String(e);
}

/**
 * @typedef {object} Failure
 * @property {string} where
 * @property {string} err
 */

/**
 * Finds the first enc3: blob so the OLD secret can be verified before any write.
 * @param {import('better-sqlite3').Database} db
 * @returns {{ where: string, ct: string, aad: string } | null}
 */
function findFirstEnc3(db) {
	for (const spec of SETTINGS_CREDENTIALS) {
		const row = /** @type {{ value: string } | undefined} */ (
			db.prepare('SELECT value FROM settings WHERE key = ?').get(spec.key)
		);
		if (!row) continue;
		let parsed;
		try { parsed = JSON.parse(row.value); } catch { continue; }
		const val = getPath(parsed, spec.path);
		if (typeof val === 'string' && val.startsWith(PREFIX_V3)) {
			return { where: `settings.${spec.label}`, ct: val, aad: `${spec.label}:1` };
		}
	}
	const agent = /** @type {{ id: string, hmac_secret: string | null } | undefined} */ (
		db.prepare("SELECT id, hmac_secret FROM agents WHERE hmac_secret LIKE 'enc3:%' LIMIT 1").get()
	);
	if (agent?.hmac_secret) {
		return { where: `agents.hmac_secret:${agent.id}`, ct: agent.hmac_secret, aad: `agent.hmacSecret:${agent.id}` };
	}
	const userCols = /** @type {Array<{ name: string }>} */ (db.prepare('PRAGMA table_info(users)').all());
	if (userCols.some((c) => c.name === 'totp_secret')) {
		const user = /** @type {{ id: string, totp_secret: string | null } | undefined} */ (
			db.prepare("SELECT id, totp_secret FROM users WHERE totp_secret LIKE 'enc3:%' LIMIT 1").get()
		);
		if (user?.totp_secret) {
			return { where: `users.totp_secret:${user.id}`, ct: user.totp_secret, aad: `users.totpSecret:${user.id}` };
		}
	}
	return null;
}

async function main() {
	const { values } = parseArgs({
		options: {
			db: { type: 'string' }, old: { type: 'string' }, new: { type: 'string' },
			'dry-run': { type: 'boolean', default: false }
		}
	});
	const dryRun = values['dry-run'] === true;
	if (!values.db || !values.old || !values.new) {
		console.error('Usage: node scripts/rotate-session-secret.mjs --db <path> --old <hex32> --new <hex32> [--dry-run]');
		process.exit(2);
	}
	if (values.old.length < 32 || values.new.length < 32) {
		console.error('FATAL: both secrets must be at least 32 chars');
		process.exit(2);
	}
	if (values.old === values.new) {
		console.error('FATAL: --new must differ from --old');
		process.exit(2);
	}
	if (!fs.existsSync(values.db)) {
		console.error(`FATAL: db not found at ${values.db}`);
		process.exit(2);
	}

	const oldKey = deriveMasterKey(values.old);
	const newKey = deriveMasterKey(values.new);
	const db = new Database(values.db);

	// Pre-flight: prove --old decrypts the first enc3: blob before writing anything.
	const probe = findFirstEnc3(db);
	if (probe) {
		try {
			decryptEnc3(probe.ct, oldKey, probe.aad);
		} catch (e) {
			console.error(`FATAL: --old does not decrypt ${probe.where} (${errMsg(e)}).`);
			console.error('Wrong old secret, or this DB was written with different KDF parameters. No changes were made.');
			db.close();
			process.exit(2);
		}
	}

	/** @type {{ settings: number, agentsHmac: number, agentsRdp: number, usersTotp: number, cleared: number }} */
	const counts = { settings: 0, agentsHmac: 0, agentsRdp: 0, usersTotp: 0, cleared: 0 };
	/** @type {Failure[]} */
	const failures = [];

	const tx = db.transaction(() => {
		// settings rows
		for (const spec of SETTINGS_CREDENTIALS) {
			const row = /** @type {{ value: string } | undefined} */ (
				db.prepare('SELECT value FROM settings WHERE key = ?').get(spec.key)
			);
			if (!row) continue;
			/** @type {Record<string, any>} */
			let parsed;
			try { parsed = JSON.parse(row.value); } catch { failures.push({ where: `settings.${spec.key}`, err: 'invalid JSON' }); continue; }
			if (!parsed || typeof parsed !== 'object') continue;
			let changed = false;
			const p = spec.path;
			const cur = getPath(parsed, p);
			if (typeof cur === 'string' && cur.startsWith(PREFIX_V3)) {
				try {
					const next = rewrap(cur, oldKey, newKey, `${spec.label}:1`);
					if (next) { setPath(parsed, p, next); changed = true; counts.settings++; }
				} catch (e) {
					failures.push({ where: `settings.${spec.label}`, err: errMsg(e) });
				}
			}
			if (changed && !dryRun) {
				db.prepare('UPDATE settings SET value = ? WHERE key = ?').run(JSON.stringify(parsed), spec.key);
			}
		}

		// agents.hmac_secret + agents.data.remoteDesktop.*
		const agents = /** @type {Array<{ id: string, hmac_secret: string | null, data: string | null }>} */ (
			db.prepare("SELECT id, hmac_secret, data FROM agents WHERE hmac_secret LIKE 'enc3:%' OR (data IS NOT NULL AND data != '')").all()
		);
		for (const a of agents) {
			if (a.hmac_secret && a.hmac_secret.startsWith(PREFIX_V3)) {
				try {
					const next = rewrap(a.hmac_secret, oldKey, newKey, `agent.hmacSecret:${a.id}`);
					if (next) {
						if (!dryRun) db.prepare('UPDATE agents SET hmac_secret = ? WHERE id = ?').run(next, a.id);
						counts.agentsHmac++;
					}
				} catch (e) { failures.push({ where: `agents.hmac_secret:${a.id}`, err: errMsg(e) }); }
			}
			if (a.data) {
				/** @type {Record<string, any>} */
				let parsed;
				try { parsed = JSON.parse(a.data); } catch { continue; }
				const rd = parsed?.remoteDesktop;
				if (rd && typeof rd === 'object') {
					let changed = false;
					for (const field of ['password', 'privateKey']) {
						if (typeof rd[field] === 'string' && rd[field].startsWith(PREFIX_V3)) {
							try {
								const next = rewrap(rd[field], oldKey, newKey, `agent.remoteDesktop.${field}:${a.id}`);
								if (next) { rd[field] = next; changed = true; counts.agentsRdp++; }
							} catch (e) { failures.push({ where: `agents.remoteDesktop.${field}:${a.id}`, err: errMsg(e) }); }
						}
					}
					if (changed && !dryRun) {
						db.prepare('UPDATE agents SET data = ? WHERE id = ?').run(JSON.stringify(parsed), a.id);
					}
				}
			}
		}

		// users.totp_secret (column is added by a schema migration; tolerate old DBs without it)
		const userCols = /** @type {Array<{ name: string }>} */ (db.prepare('PRAGMA table_info(users)').all());
		if (userCols.some((c) => c.name === 'totp_secret')) {
			const users = /** @type {Array<{ id: string, totp_secret: string | null }>} */ (
				db.prepare("SELECT id, totp_secret FROM users WHERE totp_secret LIKE 'enc3:%'").all()
			);
			for (const u of users) {
				try {
					const next = rewrap(u.totp_secret, oldKey, newKey, `users.totpSecret:${u.id}`);
					if (next) {
						if (!dryRun) db.prepare('UPDATE users SET totp_secret = ? WHERE id = ?').run(next, u.id);
						counts.usersTotp++;
					}
				} catch (e) { failures.push({ where: `users.totp_secret:${u.id}`, err: errMsg(e) }); }
			}
		}

		if (!dryRun) {
			const cl1 = db.prepare('DELETE FROM sessions').run().changes;
			const cl2 = db.prepare('DELETE FROM mfa_used_challenges').run().changes;
			const cl3 = db.prepare('DELETE FROM mfa_step_up_used_codes').run().changes;
			// Session-token hashes are HMACs over the OLD secret and can no
			// longer be matched — drop them. Agent bearer/enrolment-token
			// hashes use the dedicated per-install pepper
			// (settings.agentTokenPepper), NOT SESSION_SECRET, so enrolled
			// agents and pending enrolment tokens keep working after rotation.
			counts.cleared = cl1 + cl2 + cl3;
		}

		// Atomicity: one bad blob means the whole rotation is unsafe.
		if (failures.length > 0 && !dryRun) throw new Error('__ROLLBACK__');
	});

	let rolledBack = false;
	try {
		tx();
	} catch (e) {
		if (e instanceof Error && e.message === '__ROLLBACK__') {
			rolledBack = true;
		} else {
			console.error('FATAL:', e);
			db.close();
			process.exit(1);
		}
	}
	db.close();

	const label = rolledBack ? 'Re-wrapped (rolled back — DB unchanged)' : 'Re-wrapped';
	console.log(`${dryRun ? '[DRY RUN] ' : ''}${label}:`);
	console.log(`  settings credentials   : ${counts.settings}`);
	console.log(`  agent HMAC secrets     : ${counts.agentsHmac}`);
	console.log(`  agent RDP creds        : ${counts.agentsRdp}`);
	console.log(`  user TOTP secrets      : ${counts.usersTotp}`);
	console.log(`  sessions/MFA rows cleared: ${counts.cleared}`);
	if (failures.length) {
		console.error(`\n${failures.length} failure(s):`);
		for (const f of failures) console.error(`  ${f.where}: ${f.err}`);
		process.exit(1);
	}
	if (!dryRun) {
		console.log('\nNext steps:');
		console.log('  1. Update SESSION_SECRET in the environment to the new value.');
		console.log('  2. Start the service. Boot will re-anchor the audit log; pre-rotation rows show as unverified.');
		console.log('  3. Regenerate TOTP recovery codes (HMAC hashes are not reversible).');
	}
}

main().catch(e => { console.error('FATAL:', e); process.exit(1); });
