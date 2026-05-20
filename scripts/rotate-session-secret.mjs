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
 *   - settings: emails.smtp.pass, uptime.telegram.botToken, ai.apiKey,
 *     backup.encryptionPassphrase, backup.offsite.s3.secretAccessKey,
 *     backup.offsite.webdav.password, rmm.updateManifestPrivateKey
 *   - agents: hmac_secret column + data.remoteDesktop.{password,privateKey}
 *   - users: data.totpSecret
 *
 * What it does NOT touch (operator must handle manually):
 *   - TOTP recovery code hashes — HMACs, not reversible. Regenerate codes.
 *   - mfa_used_challenges + mfa_step_up_used_codes + sessions — cleared.
 *   - Audit log per-row HMACs — boot-time recomputeAuditAnchor() will
 *     re-anchor; verifier will treat pre-rotation rows as unverified.
 *     Export to file BEFORE rotation if you want a verifiable archive.
 */
import Database from 'better-sqlite3';
import crypto from 'node:crypto';
import { parseArgs } from 'node:util';
import fs from 'node:fs';

const PREFIX_V3 = 'enc3:';
const KEY_LEN = 32, IV_LEN = 12, TAG_LEN = 16, SALT_LEN = 16;

function deriveMasterKey(secret) {
	return crypto.scryptSync(secret, 'itcake-master-key-v2', KEY_LEN);
}

function deriveFieldKey(masterKey, salt) {
	return Buffer.from(crypto.hkdfSync('sha256', masterKey, salt, 'itcake-field-encryption', KEY_LEN));
}

function decryptEnc3(ct, masterKey, aad) {
	if (!ct.startsWith(PREFIX_V3)) throw new Error('not enc3:');
	const buf = Buffer.from(ct.slice(PREFIX_V3.length), 'base64');
	const salt = buf.subarray(0, SALT_LEN);
	const iv = buf.subarray(SALT_LEN, SALT_LEN + IV_LEN);
	const tag = buf.subarray(SALT_LEN + IV_LEN, SALT_LEN + IV_LEN + TAG_LEN);
	const enc = buf.subarray(SALT_LEN + IV_LEN + TAG_LEN);
	const key = deriveFieldKey(masterKey, salt);
	const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
	decipher.setAuthTag(tag);
	if (aad) decipher.setAAD(Buffer.from(aad, 'utf-8'));
	return Buffer.concat([decipher.update(enc), decipher.final()]).toString('utf-8');
}

function encryptEnc3(plain, masterKey, aad) {
	const salt = crypto.randomBytes(SALT_LEN);
	const iv = crypto.randomBytes(IV_LEN);
	const key = deriveFieldKey(masterKey, salt);
	const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
	if (aad) cipher.setAAD(Buffer.from(aad, 'utf-8'));
	const enc = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
	const tag = cipher.getAuthTag();
	return PREFIX_V3 + Buffer.concat([salt, iv, tag, enc]).toString('base64');
}

function rewrap(ct, oldKey, newKey, aad) {
	if (!ct || typeof ct !== 'string' || !ct.startsWith(PREFIX_V3)) return null;
	const plain = decryptEnc3(ct, oldKey, aad);
	return encryptEnc3(plain, newKey, aad);
}

const SETTINGS_PATHS = [
	{ key: 'emails',    paths: [['smtp', 'pass']] },
	{ key: 'uptime',    paths: [['telegram', 'botToken']] },
	{ key: 'ai',        paths: [['apiKey']] },
	{ key: 'backup',    paths: [['encryptionPassphrase'], ['offsite', 's3', 'secretAccessKey'], ['offsite', 'webdav', 'password']] },
	{ key: 'rmm',       paths: [['updateManifestPrivateKey']] },
	{ key: 'telemetry', paths: [['errorReportingDsn']] }
];
function settingsAad(key, p) { return `${key}.${p.join('.')}:1`; }

function getPath(obj, p) {
	let cur = obj;
	for (const k of p) { if (cur == null) return undefined; cur = cur[k]; }
	return cur;
}
function setPath(obj, p, v) {
	let cur = obj;
	for (let i = 0; i < p.length - 1; i++) { if (cur[p[i]] == null) cur[p[i]] = {}; cur = cur[p[i]]; }
	cur[p[p.length - 1]] = v;
}

async function main() {
	const { values } = parseArgs({
		options: {
			db: { type: 'string' }, old: { type: 'string' }, new: { type: 'string' },
			'dry-run': { type: 'boolean', default: false }
		}
	});
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

	const counts = { settings: 0, agentsHmac: 0, agentsRdp: 0, usersTotp: 0, cleared: 0 };
	const failures = [];

	const tx = db.transaction(() => {
		// settings rows
		for (const spec of SETTINGS_PATHS) {
			const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(spec.key);
			if (!row) continue;
			let parsed;
			try { parsed = JSON.parse(row.value); } catch { failures.push({ where: `settings.${spec.key}`, err: 'invalid JSON' }); continue; }
			let changed = false;
			for (const p of spec.paths) {
				const cur = getPath(parsed, p);
				if (typeof cur !== 'string' || !cur.startsWith(PREFIX_V3)) continue;
				try {
					const next = rewrap(cur, oldKey, newKey, settingsAad(spec.key, p));
					if (next) { setPath(parsed, p, next); changed = true; counts.settings++; }
				} catch (e) {
					failures.push({ where: `settings.${spec.key}.${p.join('.')}`, err: e.message });
				}
			}
			if (changed && !values['dry-run']) {
				db.prepare('UPDATE settings SET value = ? WHERE key = ?').run(JSON.stringify(parsed), spec.key);
			}
		}

		// agents.hmac_secret
		const agents = db.prepare("SELECT id, hmac_secret, data FROM agents WHERE hmac_secret LIKE 'enc3:%' OR (data IS NOT NULL AND data != '')").all();
		for (const a of agents) {
			if (a.hmac_secret && a.hmac_secret.startsWith(PREFIX_V3)) {
				try {
					const next = rewrap(a.hmac_secret, oldKey, newKey, `agent.hmacSecret:${a.id}`);
					if (next) {
						if (!values['dry-run']) db.prepare('UPDATE agents SET hmac_secret = ? WHERE id = ?').run(next, a.id);
						counts.agentsHmac++;
					}
				} catch (e) { failures.push({ where: `agents.hmac_secret:${a.id}`, err: e.message }); }
			}
			if (a.data) {
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
							} catch (e) { failures.push({ where: `agents.remoteDesktop.${field}:${a.id}`, err: e.message }); }
						}
					}
					if (changed && !values['dry-run']) {
						db.prepare('UPDATE agents SET data = ? WHERE id = ?').run(JSON.stringify(parsed), a.id);
					}
				}
			}
		}

		// users.data.totpSecret (or users.totpSecret column if denormalized — check both)
		const userCols = db.prepare("PRAGMA table_info(users)").all().map(c => c.name);
		if (userCols.includes('totp_secret')) {
			const users = db.prepare("SELECT id, totp_secret FROM users WHERE totp_secret LIKE 'enc3:%'").all();
			for (const u of users) {
				try {
					const next = rewrap(u.totp_secret, oldKey, newKey, `users.totpSecret:${u.id}`);
					if (next) {
						if (!values['dry-run']) db.prepare('UPDATE users SET totp_secret = ? WHERE id = ?').run(next, u.id);
						counts.usersTotp++;
					}
				} catch (e) { failures.push({ where: `users.totp_secret:${u.id}`, err: e.message }); }
			}
		}

		if (!values['dry-run']) {
			const cl1 = db.prepare('DELETE FROM sessions').run().changes;
			const cl2 = db.prepare('DELETE FROM mfa_used_challenges').run().changes;
			const cl3 = db.prepare('DELETE FROM mfa_step_up_used_codes').run().changes;
			counts.cleared = cl1 + cl2 + cl3;
		}
	});

	tx();
	db.close();

	const mode = values['dry-run'] ? '[DRY RUN] ' : '';
	console.log(`${mode}Re-wrapped:`);
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
	if (!values['dry-run']) {
		console.log('\nNext steps:');
		console.log('  1. Update SESSION_SECRET in the environment to the new value.');
		console.log('  2. Start the service. Boot will re-anchor the audit log; pre-rotation rows show as unverified.');
		console.log('  3. Regenerate TOTP recovery codes (HMAC hashes are not reversible).');
	}
}

main().catch(e => { console.error('FATAL:', e); process.exit(1); });
