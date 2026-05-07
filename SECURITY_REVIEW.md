# ITCake — Security & Code Review

Branch: `claude/security-code-review-PWByj`
Date: 2026-05-07
Method: deep parallel read by specialist subagents (auth, HTTP/CSRF, crypto, RMM, AI, SSRF, backups+RD, Go agent, frontend+SQL) plus direct file:line verification.

> **Threat model.** Single-user self-hosted admin app. Operator is trusted; their cookie session and `SESSION_SECRET` are the keys to the kingdom. Adversaries we worry about:
> (a) cross-origin web attackers reaching the running instance,
> (b) network-position attackers (CA-trusted MITM, rogue proxy, leaky logs),
> (c) compromised individual agents,
> (d) DB-only attackers (e.g. via a leaked backup),
> (e) anything that escalates AI-controlled tool use beyond what the operator approved,
> (f) malicious local users on a host where the agent runs as root.

Severity scale: **CRITICAL** = full takeover or silent data loss exploitable today; **HIGH** = significant compromise under realistic conditions; **MEDIUM** = harder to weaponise but real; **LOW** = hardening / defense-in-depth; **INFO** = noted, no fix required.

---

## TL;DR — fix order (top of pile)

| # | Severity | Title | Files |
|---|---|---|---|
| 1 | CRITICAL | `ai.apiKey` returned in **plaintext** from `GET /api/settings` (no masking branch for `ai`) — XSS / cookie-theft / DB-read = free Anthropic key | `src/services/settings.ts:9-36`, `src/routes/api/settings/+server.ts:33-43` |
| 2 | CRITICAL | `enableMfa` does **not** require the current password — cookie-only path lets a stolen cookie plant the attacker's TOTP secret and lock the operator out | `src/routes/api/auth/mfa/+server.ts:41-52`, `src/services/auth-mfa.ts:79-95` |
| 3 | CRITICAL | macOS / Linux **PATH hijack** of `system_profiler`, `journalctl`, `log`, `sysctl`, `defaults`, `wmic`, `powershell` etc. — agent prepends `/opt/homebrew/bin`, `/usr/local/bin` to PATH and runs as root, so any local non-root user can plant a binary that the agent will execute as root | `agent/internal/{peripheral,eventlog,bootperf,reliability,cis,hwinfo,packages}/*.go`, `agent/internal/commands/extendedEnv` |
| 4 | HIGH | `mfaToken` is **not consumed on failed second-step attempts** — captured token is replayable for the entire 5 min TTL | `src/routes/api/auth/login/+server.ts:26-42` |
| 5 | HIGH | Settings credentials (SMTP / Telegram / **AI API key** / S3 / WebDAV / backup passphrase) are stored as **enc2 with no AAD**, contradicting CLAUDE.md's enc3-AAD claim | `src/lib/server/db.ts:1229-1248`, `src/lib/server/field-crypto.ts:34-57` |
| 6 | HIGH | `/api/rmm/update-manifest-key` is **CSRF-exempt but cookie-authenticated** — once cookie sameSite policy ever loosens or a same-origin XSS lands, an attacker can rotate/remove the Ed25519 manifest key and break the auto-update second factor for the whole fleet | `src/routes/api/rmm/update-manifest-key/+server.ts:13`, `src/hooks.server.ts:123` |
| 7 | HIGH | `recomputeAuditAnchor()` silently rebases the integrity anchor with no "row count must not shrink" guard — anyone with `SESSION_SECRET` (e.g. via `.env` exfil) can truncate-and-re-anchor; CLAUDE.md's "tail-truncation detection" is then false | `src/lib/server/changes.ts:176-182` |
| 8 | HIGH | `documents.type` CHECK constraint **omits** `custom_field_def` and `saved_filter` — both consumers will throw `CHECK constraint failed` on insert against a fresh DB; the integrity probe loop only tests two existing types so it never trips | `src/lib/server/db.ts:49, 843, 886-896`; `src/services/{custom-fields,saved-filters}.ts` |
| 9 | HIGH | Plan-mode auto-approve matches `agentId` + `action` only — model can issue any `payload.command` under an approved-shell step ("approved as `systemctl status nginx`", actually executes `rm -rf /`) | `src/lib/server/ai/plan-mode.ts:29-34, 162-168` |
| 10 | HIGH | SSE `approval_required` event leaks raw `tu.input` and the audit log row stores `tool_input` unredacted — secrets dug up in earlier Tier 1 calls reach the operator UI / DOM logs / extensions | `src/services/ai-session.ts:386-389` |
| 11 | HIGH | `maxTurnsPerSession` (default 50) **is never enforced** — only the 10-iteration tool-loop cap and budget check apply | `src/services/ai-session.ts:254-454` |
| 12 | HIGH | Agent enumeration helpers shell out to `system_profiler` / `journalctl` / `log` / `sysctl` / `wmic` / `powershell` **without absolute path** — `commands.ExtendedPath()` puts user-writable dirs ahead of `/usr/bin`, so a console user can hijack root execution | `agent/internal/peripheral/enumerate_darwin.go:21`, `eventlog/eventlog_*.go`, `bootperf/bootperf_*.go`, `cis/checks_*.go`, etc. |
| 13 | HIGH | Package-manager install/uninstall builders concatenate the validated `pkg` name into a shell string passed to `/bin/sh -c` — held safe today by `pkgNameRE`, but a single regex relaxation = RCE on every endpoint | `agent/internal/packages/{apt,dnf,pacman,apk,npm,pip,brew,winget,choco,scoop,apps_darwin}.go` |
| 14 | HIGH | Backup `restoreBackup` is **not atomic** with the upload-dir swap — process kill mid-restore leaves DB-restored but uploads-old/missing, no automatic pre-restore snapshot | `src/services/backups.ts:550-617` |
| 15 | HIGH | `previewRestore()` writes the plaintext temp DB at `0o644` (default umask) — local non-root user can race-read every encrypted-but-now-decrypted credential | `src/services/backups.ts:684-692` |
| 16 | HIGH | `pickPresentKeys` walks the prototype chain via `key in parsed` — `{toString:'x'}` etc. land in update payloads; combined with a future `Object.assign(existing, safe)` consumer, this is a prototype-pollution-by-overwrite primitive | `src/lib/server/request-utils.ts:50-59` |
| 17 | MEDIUM | CSV exports do **not** prefix `=`/`+`/`-`/`@`/`\t` to neutralise Excel/Numbers formula injection | `src/lib/server/csv.ts:13-32` |
| 18 | MEDIUM | `handleActionPost` action allowlist uses `action in config.actions` — walks the prototype chain (`__proto__`, `toString`, `hasOwnProperty` all pass; subsequent call crashes 500, no escalation) | `src/lib/server/request-utils.ts:113` |
| 19 | MEDIUM | Audit-log chain accepts the deprecated `chainHashV0` (`|`-delimited, ambiguous against `|` in JSON diffs) **forever** | `src/lib/server/changes.ts:104-114, 217-223` |
| 20 | MEDIUM | Enrollment-token creation is **not audit-logged** and has **no per-operator cap** — a hostile session can mint thousands of valid 15-min single-use tokens with no chain of custody | `src/services/agents.ts:179-189`, `src/routes/api/agents/enrollment-tokens/+server.ts:12-23` |
| 21 | MEDIUM | Login form-action twin (`/login`) does **not** record rate-limit attempts on Zod failure, while the JSON path does — differential rate-limit semantics | `src/routes/login/+page.server.ts:35-46` vs `src/routes/api/auth/login/+server.ts:14-20` |
| 22 | MEDIUM | `parseJsonBody` accepts `Content-Type: text/json` and a missing `Content-Type` — silently broadens JSON-CSRF surface | `src/lib/server/request-utils.ts:11-13` |
| 23 | MEDIUM | Saved-filter and custom-field-def JSON is **not re-validated against Zod on read** — a tampered DB / restored-from-evil-backup row reaches the filter engine bypassing schema | `src/lib/server/filter-fields.ts:88-112`, `src/services/saved-filters.ts:40-43` |
| 24 | MEDIUM | Replay-cache `replay-cache.json` (Go agent) silently resets on parse error — local fs-write attacker can reset replay protection by planting `{}` or invalid JSON before agent restart | `agent/internal/commands/replay.go:67-68` |
| 25 | MEDIUM | Anthropic model name is operator-supplied **free text** (no allowlist) — switching to a more expensive future model is a budget-bypass without code changes | `src/services/ai-session.ts:293`, `src/lib/server/ai/cost-tracker.ts:11-18` |
| 26 | MEDIUM | Monthly budget guard is read-then-write — concurrent turns from multiple tabs can both pass `$49.50 < $50` and both run | `src/services/ai-session.ts:268-272, 434` |
| 27 | MEDIUM | `sanitizeUserText` is ASCII-only — Cyrillic/Greek homoglyph (`іgnore previous instructions`) bypasses every prompt-injection pattern | `src/lib/server/ai/sanitizer.ts:19-31` |
| 28 | MEDIUM | `sanitizePageContext` does not recurse — nested objects (`{tabs:[{title:"…"}]}`) bypass sanitization entirely | `src/lib/server/ai/sanitizer.ts:68-82` |
| 29 | MEDIUM | Approval-gate Map is in-memory; server restart leaves DB rows `pending` forever, and a stale operator approval will audit-log "approved" without anything actually executing | `src/lib/server/ai/approval-map.ts`, `src/services/ai-session.ts:390-391` |
| 30 | MEDIUM | Bearer-token agent secret is accepted from the agent at enrollment with no entropy check — server should generate it instead | `src/lib/validators-rmm.ts:19`, `src/services/agents.ts:236-239` |
| 31 | MEDIUM | No per-agent checkin rate limit — a compromised single agent can DoS the SQLite WAL with sustained 1 MiB checkins | `src/routes/api/rmm/checkin/+server.ts:25-186` |

Lower-severity / informational items follow each section.

---

## A. AUTH / SESSION / MFA

### A1 — CRITICAL: `enableMfa` does not re-verify the user's password

**Where.** `src/routes/api/auth/mfa/+server.ts:41-52` (case `'enable'`); service `src/services/auth-mfa.ts:79-95`.

The MFA setup is two POSTs:
- `init` → requires `currentPassword`. Server returns a fresh secret + recovery codes back to the client.
- `enable` → only requires the cookie session and trusts the **client-supplied** `secret`, `code`, `recoveryCodes`. No `currentPassword`.

**Exploit chain (cookie-theft, no password).**
1. Skip `init` entirely.
2. Pick attacker-controlled TOTP secret + matching code.
3. POST `{action:'enable', secret:'<attacker secret>', code:'<derived TOTP>', recoveryCodes:['<10 strings the attacker holds>']}`.
4. `enableMfa` succeeds. `enableMfaTx` revokes all sessions including the legitimate one (`auth-mfa.ts:100`).
5. The legitimate operator can no longer log in: their TOTP app does not know the new secret, and the recovery codes are also attacker-controlled. **Account lockout.**

`disable` already requires `currentPassword` (`auth-mfa.ts:113`); the asymmetry is the bug.

**Fix (one of):**
- (A) Add `currentPassword` to `mfaEnableSchema` and verify it before `enableMfa`.
- (B) Make `init` server-stateful: store the proposed secret in a short-lived `mfa_pending_setup` row, then `enable` proves possession by submitting only the matching TOTP code. The secret never leaves the server.

(A) immediately, (B) as a follow-up — it eliminates the entire "attacker brings their own secret" class.

---

### A2 — HIGH: `mfaToken` is not consumed on failed step-2 attempts

**Where.** `src/routes/api/auth/login/+server.ts:26-42`.

```ts
if (mfaToken) {
    const challenge = verifyMfaChallenge(mfaToken);
    if (!challenge) throw error(401, '...');
    const user = await verifyPassword(email, password);
    if (!user || user.id !== challenge.userId) throw error(401, '...');
    const codeKind = mfaCode ? verifyMfaCode(challenge.userId, mfaCode) : null;
    if (!codeKind) throw error(401, '...');
    if (!consumeMfaChallenge(mfaToken)) throw error(401, '...');
    if (codeKind === 'recovery' && !consumeRecoveryCode(challenge.userId, mfaCode!)) throw error(401, '...');
    ...
}
```

`consumeMfaChallenge` is the LAST gate — every earlier failure leaves the token reusable for the rest of its 5-min TTL. A captured `mfaToken` (proxy log, screen-share, log file) is replayable: bad-password attempts return 401 but **do not burn the token**.

The per-email rate-limit (3/15 min) still applies, so the practical attack is bounded — but the token-burn semantic is wrong.

**Fix.** Move `consumeMfaChallenge` to immediately after `verifyMfaChallenge` returns success. Treat its failure as terminal; subsequent password/TOTP failures don't affect it. A captured token then yields **one** post-issue attempt window, not 5 minutes' worth.

---

### A3 — MEDIUM: Login form-action twin doesn't drain rate-limit on Zod failure

**Where.** `src/routes/api/auth/login/+server.ts:14-20` (records) vs `src/routes/login/+page.server.ts:35-46` (does not).

The JSON path increments `login_global` and `ip:<ip>` on Zod failure. The form-action path returns `fail(400)` with no `recordAttempt`. An attacker can pump invalid form bodies through the form path indefinitely (no buckets touched), then switch to JSON for the real attempts. Or pump invalid JSON to push `login_global` to 30 and lock out the legit user from the JSON path while form stays usable.

**Fix.** Form action calls `recordAttempt('login_global')` and `recordAttempt('ip:'+ip)` on validation failure, mirroring JSON.

---

### A4 — LOW: `verifyMfaCode` allows TOTP reuse within its 30 s window

**Where.** `src/services/auth-mfa.ts:157-167`.

`verifyMfaCode` is read-only; same valid TOTP can be submitted multiple times within its window. RFC 6238 §5.2 says verifier MUST NOT accept the same OTP twice. Combined with A2, a captured TOTP is replayable for ~30 s.

**Fix.** Track per-user "last consumed TOTP counter" and reject reuse.

---

### A5 — INFO: cookie hardening, Origin/Referer logic, deep-merge proto pollution defense are correct

`auth.ts:39-47`: `httpOnly`, `secure` (non-dev), `sameSite:'strict'`, `path:'/'`. Origin/Referer logic in `hooks.server.ts:119-148` correctly handles missing-Origin → fallback to Referer → fail; "null" Origin rejected; relative referer rejected; trailing slash impossible (URL.origin strips). `services/settings.ts:43-64` BANNED_KEYS includes `__proto__/constructor/prototype/__defineGetter__/__defineSetter__/__lookupGetter__/__lookupSetter__` and depth limit MAX_MERGE_DEPTH=5 with the deep-shallow fallback also skipping banned keys.

---

## B. CRYPTO / FIELD-CRYPTO / AUDIT LOG

### B1 — CRITICAL: `ai.apiKey` is **not masked** in `GET /api/settings`

**Where.** `src/services/settings.ts:9-36`. The masking switch covers `emails.smtp.pass`, `uptime.telegram.botToken`, `backup.encryptionPassphrase`, `backup.offsite.s3.secretAccessKey`, `backup.offsite.webdav.password`. It does **not** cover `ai.apiKey`. `decryptSettingsFields` at `db.ts:1217-1218` decrypts on read, so any authenticated `GET /api/settings` returns the plaintext Anthropic API key.

**Exploit.** XSS / malicious browser extension / compromised browser session / over-shoulder console / leaked API trace = free Anthropic key, billable to operator. Breaks the "API key never returned via API" invariant in CLAUDE.md.

**Fix.** Add an `ai` branch to `getAllSettings`:
```ts
if (row.key === 'ai') {
    const a = parsed as { apiKey?: string };
    if (a.apiKey) a.apiKey = '***';
}
```
And: when accepting an `ai` settings update, treat `'***'` as "preserve prior value" (mirroring the SMTP pattern).

---

### B2 — HIGH: Settings credentials are **enc2 with no AAD** despite CLAUDE.md claiming enc3

**Where.** `src/lib/server/db.ts:1229-1248` (`encryptSettingsFields`), `src/lib/server/field-crypto.ts:34-57` (`encryptField`).

```ts
// field-crypto.ts:55
const prefix = aad ? PREFIX_V3 : PREFIX_V2;
```

`encryptSettingsFields` calls `encryptField(v)` (no AAD) for every credential: `emails.smtp.pass`, `uptime.telegram.botToken`, **`ai.apiKey`** (CLAUDE.md says enc3 AAD `ai.apiKey:1`), `backup.encryptionPassphrase`, `backup.offsite.s3.secretAccessKey`, `backup.offsite.webdav.password`. All end up as `enc2:` blobs with no row-binding.

For singleton settings the AAD matters less than for per-row blobs, but: (a) CLAUDE.md misrepresents the on-disk reality, (b) a future migration touching these blobs will encounter `decryptField`'s silent fail (`backup-offsite.ts:190` returns `''` if its blob ever upgrades to enc3 without aad), and (c) cross-blob substitution (swap SMTP-password ciphertext into `ai.apiKey` slot) succeeds today.

**Fix.** Plumb AAD through `checkAndDecrypt` / `maybeEncrypt` in `db.ts:1199, 1230` — pass `'ai.apiKey:1'`, `'emails.smtp.pass:1'`, etc. Add a one-shot migration that re-wraps existing enc2 blobs to enc3, mirroring `migrateUserTotpSecretsToV3` (`db.ts:670-672`). Add a unit test that pins the prefix to `enc3:` for every settings secret after `setSetting`.

---

### B3 — HIGH: `recomputeAuditAnchor` is itself a tail-truncation primitive

**Where.** `src/lib/server/changes.ts:176-182`. Called from `hooks.server.ts:33` (after the daily 1-year prune) and `services/backups.ts:604` (after restore). No guard against a smaller `row_count` than the previously-anchored value.

**Exploit (DB + SESSION_SECRET).** Attacker who possesses a backup ZIP plus the `.env`:
1. Delete N rows from the tail of `changes`.
2. Run `recomputeAuditAnchor()` (or any equivalent SQL with a freshly computed hmac).
3. Integrity check now reports `anchor: 'ok'`.

The chain hash's `prev_hash` linkage detects mid-chain tampering; the anchor is supposed to detect tail-truncation. With this primitive available, "the anchor blocks tail-truncation" is true only if `recomputeAuditAnchor` is called exclusively in legitimate code paths.

**Fix.** Refuse to write a smaller `row_count` than the existing anchor unless caller passes an explicit `{allowTruncate: true}` opt-in. The 1-year prune and post-restore call are the only legitimate callers — they opt in. Everyone else fails closed. **Bonus:** persist a one-shot installation salt at first boot (random 16 bytes in `settings`) and include it in both `chainHash` and `anchorHmac`. Binds the chain to the installation; cross-installation chain-splice becomes impossible.

---

### B4 — MEDIUM: Audit-log accepts `chainHashV0` (legacy `|`-delimited) **forever**

**Where.** `src/lib/server/changes.ts:104-114`, `:217-223`.

```ts
const ok = matches(expectV1) || matches(expectV0);
```

v0 used `${prev}|${id}|${entityType}|${entityId}|${action}|${diffJson}|${userId}|${createdAt}` — `|` delimiter is ambiguous against `|` in `diffJson`. v1 fixed this with length-prefixed encoding. There's no `hash_version` column, so the verifier can't distinguish "v0 row" from "forged row". Combined with B3, this widens the surface forever at zero current benefit.

**Fix.** Add `hash_version INTEGER NOT NULL DEFAULT 1` on `changes`. Backfill 0 for legacy rows by detecting which encoding hashes correctly. Reject v0 for any row created after a documented cutoff.

---

### B5 — MEDIUM: SESSION_SECRET length check is module-import-only

**Where.** `src/lib/server/auth.ts:18-34`, `src/lib/server/agent-auth.ts:8-18`, `src/lib/server/changes.ts:84-86`.

The throw fires only when these modules are imported. A future refactor that lazy-imports them would silently bypass the check. `assertProductionInvariants()` in `startup-invariants.ts` is the central place but doesn't include the SESSION_SECRET length check.

**Fix.** Hoist the SESSION_SECRET presence + length check (≥32 chars in prod) into `startup-invariants.ts`. Belt-and-braces.

---

### B6 — LOW: Backup temp DB written to BACKUP_DIR with default umask

**Where.** `src/services/backups.ts` (full restore correctly chmods to 0o600 immediately; but `previewRestore` at `:684-692` writes plaintext to `_preview_<ts>.db` via `writeFileSync(tmpPath, dbBuffer)` with no `mode:`).

Default umask 0o022 produces 0o644 — local non-root user can race-read every credential the backup carries during the brief window before `unlinkSync`. **See also H15 in TL;DR.**

**Fix.** Pass `{ mode: 0o600 }` to `writeFileSync`, OR use `openSync(... O_CREAT|O_EXCL|O_WRONLY|O_NOFOLLOW, 0o600)` (matching the upload-extraction path's pattern).

---

### B7 — LOW: `signCommand` HMAC payload is colon-delimited (collision in theory only)

**Where.** `src/lib/server/agent-auth.ts:61`. The HMAC message is `${commandId}:${agentId}:${type}:${payload}:${timestamp}`. JSON `payload` and ISO `timestamp` both contain `:`. Pre-image collision against 256-bit HMAC is computationally infeasible — not exploitable.

**Fix.** Migrate to length-prefix encoding in lockstep with the Go agent. Cheap one-time refactor; breaks signature compatibility, do it during the next forced agent redeploy.

---

### B8 — LOW: 80-bit recovery codes (informational)

**Where.** `src/lib/server/totp.ts:83-92`. `RECOVERY_CODE_BYTES = 10` → 80-bit, hashed with HMAC-SHA256 at rest. Below the 128-bit ideal but acceptable given the rate-limit / 10-codes-per-user constraints. **No fix required.**

---

### B9 — INFO: constant-time comparisons verified

Every secret comparison in the codebase routes through `crypto.timingSafeEqual` after length-equality:
- Recovery code at `services/auth-mfa.ts:142, 186, 208`
- MFA challenge sig at `totp.ts:144`
- Audit anchor HMAC at `changes.ts:237`
- Audit row hash at `changes.ts:221`
Session/agent token lookup goes through SQL B-tree on the HMAC-derived hash (HMAC pre-image resistance is the defense, not constant-time SQL).

---

## C. HTTP / CSRF / CSP / RATE-LIMIT

### C1 — HIGH: `/api/rmm/update-manifest-key` is CSRF-exempt but cookie-authenticated

**Where.** `src/routes/api/rmm/update-manifest-key/+server.ts:13`, `src/hooks.server.ts:123`.

`validateOrigin` returns early for `/api/rmm/*`. The exemption is justified for bearer-authenticated RMM endpoints (agents have no Origin header). It is **not** justified for this endpoint, which routes via `handleActionPost` and requires `locals.user`.

Mitigation: cookie has `sameSite:'strict'` (`auth.ts:43`), so cross-site fetches don't carry it. **But:**
- `rotate` invalidates manifest verification on every agent that pinned the old pubkey.
- `remove` disables the optional Ed25519 layer — leaving only the per-agent HMAC advisory protecting auto-update.
- Any future change of `sameSite` to `lax` (a common UX request) silently exposes this.

**Fix.** Move it to `/api/settings/rmm-update-manifest-key` (or `/api/agents/update-manifest-key`). Renaming is cleaner than adding a per-route Origin-check exception.

---

### C2 — MEDIUM: CSV formula injection

**Where.** `src/lib/server/csv.ts:13-32`.

`needsQuoting` quotes cells with separator/quote/CR/LF or leading/trailing space — but a cell **starting with** `=`, `+`, `-`, `@`, `\t`, `\r` is not prefixed with a single quote. Exporting a finding `title` of `=cmd|'/c calc'!A0`, an agent `hostname` of `@SUM(A1)`, or any audit content can pwn an analyst opening the CSV in Excel/Numbers.

**Fix.** In `escapeCell`, before `needsQuoting`:
```ts
if (s.length > 0 && /^[=+\-@\t\r]/.test(s)) s = "'" + s;
```

---

### C3 — MEDIUM: `handleActionPost` action allowlist via `action in config.actions` walks the prototype chain

**Where.** `src/lib/server/request-utils.ts:113`.

`'__proto__' in {}` is `true`. Same for `'toString'`, `'hasOwnProperty'`, `'constructor'`. They pass the gate; the subsequent `config.actions[action]` returns the inherited Object-prototype method, which is then called as if it were an `ActionHandler`:
- `__proto__` → returns the prototype object → not callable → `TypeError` → 500.
- `toString` → returns a function returning `'[object Object]'` → not a `Response` → SvelteKit error → 500.

Cookie auth is required to reach this code, so it's a clean DoS / reliability bug, not RCE.

**Fix.** Replace with `Object.prototype.hasOwnProperty.call(config.actions, action)` or — better — `typeof config.actions[action] === 'function'`.

---

### C4 — MEDIUM: `parseJsonBody` Content-Type is too permissive

**Where.** `src/lib/server/request-utils.ts:11-13`.

```ts
const ct = request.headers.get('content-type');
if (ct && !ct.startsWith('application/json') && !ct.startsWith('text/json')) throw error(415, ...);
```

- `text/json` is non-standard and not in SvelteKit's danger list.
- A missing `Content-Type` (`ct == null`) **passes the check entirely**.

Hooks `validateOrigin` is the actual CSRF protection here, so this isn't exploitable cross-origin — but it widens the documented contract.

**Fix.** Require `application/json` strictly. Drop `text/json`. Reject when `Content-Type` is missing.

---

### C5 — MEDIUM: `Content-Length` parsing is permissive

**Where.** `src/lib/server/request-utils.ts:15`.

`parseInt('1MB', 10) → 1`, `'1.99e9' → 1`, etc. The streaming cap at line 31 catches over-size bodies, so DoS is bounded. Use `Number.isInteger(Number(value))` and reject negatives.

---

### C6 — MEDIUM: `pickPresentKeys` walks the prototype chain via `key in parsed`

**Where.** `src/lib/server/request-utils.ts:50-59` (used by `parseUpdateBody:89`).

`for (const key of Object.keys(input)) { if (key in parsed) result[key] = parsed[key] }` — `in` walks the prototype chain. Body of `{toString:'x', hasOwnProperty:'y'}` lands those keys in the partial-update payload. Currently downstream services only read known fields, so impact is bounded — but if any future consumer does `Object.assign(existing, safe)` or `{...existing, ...safe}`, prototype methods get overwritten on the existing object (prototype-pollution-by-overwrite).

Also: `Object.keys(input)` for a body with `__proto__` enumerates `__proto__` as an own key in modern Node, so `result['__proto__']` is then assigned.

**Fix.** Replace `key in parsed` with `Object.prototype.hasOwnProperty.call(parsed, key)`. Skip `__proto__`/`constructor`/`prototype`/`__defineGetter__` etc. Mirror `services/settings.ts`.

---

### C7 — LOW: HSTS `preload` is sent under `NODE_ENV=test` too

**Where.** `src/hooks.server.ts:206-208`. Condition is `!== 'development'`. CLAUDE.md says "preload in prod". Tighten to `=== 'production'` or update CLAUDE.md.

---

### C8 — INFO: Origin validation, COOP/CORP/X-Content-Type-Options, Permissions-Policy, CSP layering all sound

CSP for `/api/*` is `default-src 'none'; script-src 'none'; frame-ancestors 'none'; base-uri 'none'`. The PDF-preview path adds `style-src 'unsafe-inline'; font-src data:; img-src data: blob:`. SvelteKit nonce CSP applies elsewhere. No `unsafe-eval` for scripts. Header set is comprehensive (Permissions-Policy denies 30+ features, X-Permitted-Cross-Domain-Policies, X-DNS-Prefetch-Control off, COOP/CORP same-origin, Server/X-Powered-By stripped).

---

## D. RMM / AGENT SERVER-SIDE

### D1 — MEDIUM: Enrollment-token creation has **no audit log** and **no rate limit**

**Where.** `src/services/agents.ts:179-189`, `src/routes/api/agents/enrollment-tokens/+server.ts:12-23`.

`createEnrollmentToken()` writes to `agent_enrollment_tokens` but never calls `recordChange()`. The route has no `checkAndRecordAttempt` and no per-user creation cap. A compromised operator session can mint thousands of valid 15-min single-use tokens with no chain of custody. Tokens then authorise turning hosts into authenticated RMM agents capable of receiving signed shell commands — a higher-value event than agent updates that ARE logged.

**Fix.** Inside the `db.transaction`, call `recordChange('agent', id, 'create', { enrollmentToken: { old: null, new: name } }, userId)`. Add `checkAndRecordAttempt('enroll-token-mint:'+userId, 30, ...)` in the route. Cap concurrently-active (unused, unexpired) tokens at, say, 50 per operator.

---

### D2 — MEDIUM: Agent-supplied `hmacSecret` accepted at enrollment with no entropy check

**Where.** `src/lib/validators-rmm.ts:19`, `src/services/agents.ts:236-239`.

Server validates `/^[0-9a-f]{64,128}$/i` only. Accepts `0x00 * 32`, repeated `deadbeef`, the same constant from every enrolling agent. The Go agent generates with `crypto/rand` — but the server has no way to detect a forked agent that uses a static or low-entropy secret.

**Fix.** Server-generate. In `enrollAgent`, ignore agent-supplied `hmacSecret`, generate `crypto.randomBytes(32).toString('hex')`, return in the enrollment response. Agent persists. The Go agent already accepts what the server returns elsewhere (machine-id config), so this is a clean simplification.

---

### D3 — MEDIUM: No per-agent checkin rate limit

**Where.** `src/routes/api/rmm/checkin/+server.ts:25-186`.

A compromised agent (with valid bearer) can flood `/api/rmm/checkin` at any rate. Each call writes up to 1000 services + 10000 packages + 200 events + 100 commandResults inside one transaction. The 1 MiB body cap is `parseJsonBody`'s only bound.

**Fix.** Add `checkAndRecordAttempt('checkin:'+agent.id, 60, ...)` after `authenticateAgent`. 60 per 15min ≈ one per 15s, well above the 60s legitimate cadence with jitter.

---

### D4 — MEDIUM: Alert actions dispatch shell/script commands without re-running `validateCommandPayload`

**Where.** `src/services/alerts.ts:289-312`.

`runAlertActions` calls `dispatchCommand(action.agentId, 'shell'|'script'|'service_action', ...)`. `dispatchCommand` does NOT re-run `validateCommandPayload`. Combined with D1 (no audit-log on token mint), a compromised session can plant time-delayed RCE in alert chains and the audit log won't reflect the action firing — `runAlertActions` doesn't `recordChange` either.

**Fix.** Inside `runAlertActions`, before each `dispatchCommand`, call `validateCommandPayload(action.type, ...)` and `recordChange('alert_rule', rule.id, 'update', { actionFired: { old: null, new: { type: action.type, agentId } } }, userId)`. Wrap in try/catch so a `LegacyEnrollmentError` doesn't silently break the chain.

---

### D5 — LOW: No MFA gate on enrollment-token creation or binary download

**Where.** `src/routes/api/agents/enrollment-tokens/+server.ts`, `src/routes/api/rmm/download/[os]/[arch]/+server.ts`.

Cookie-only access. Combined with D1, a hostile session has the two primitives needed to bring up an attacker-operated agent connected to the operator's server. Adding an MFA step-up makes session theft alone insufficient.

**Fix.** Require fresh TOTP/recovery code on `POST /api/agents/enrollment-tokens` when MFA is enabled. Same pattern as `filesystem_cleanup` already uses (per CLAUDE.md).

---

### D6 — LOW: `processCheckin` allows agents to rewrite `hostname` unilaterally

**Where.** `src/services/agents.ts:260-294`.

Two enrolled agents A and B can both rewrite to the same hostname via checkin and the unique-tuple invariant breaks silently. Operationally confusing; not a security boundary because bearer auth still ties to the SQL row, not the hostname.

**Fix.** Reject hostname change when it would collide with another enabled `(hostname, os, arch)`.

---

### D7 — LOW: Auto-name counter `agent_global` increments even when not used

**Where.** `src/services/agents.ts:241-242`. `incrementCounterWithMin('agent_global', 1)` runs unconditionally. The auto-name `Agent-001` is only used when no name is supplied, but the counter increments either way → leaks total historical enrollments.

**Fix.** Move `incrementCounterWithMin` inside the `if (!tokenRow.name && !data.hostname)` branch.

---

### D8 — INFO: command HMAC, payloadRaw verbatim, replay window, agentId binding all verified correct

`signCommand` payload format (B7 covers the colon-delimiter caveat). `getPendingCommandsRaw()` preserves DB bytes. `processCommandResult` requires `agentId`. Bearer auth on `/api/rmm/*` correctly hashes incoming token via SESSION_SECRET-keyed HMAC.

---

## E. AI BRAIN

### E1 — CRITICAL: `ai.apiKey` plaintext leak via `GET /api/settings`

**See B1 above.** Same finding, listed under both crypto and AI brain because the consequence is BYOK Anthropic key disclosure (billable, can pivot to abuse other Anthropic services if key is reused).

---

### E2 — HIGH: Plan-mode auto-approve ignores payload contents

**Where.** `src/lib/server/ai/plan-mode.ts:29-34, 162-168`. `KEY_FIELDS = ['agentId','action','scriptId','policyId','monitorId','ticketId','invoiceId','clientId','filename']`.

For `dispatch_agent_command`, plan-time enforcement (`tools/plan.ts:78-86`) requires both `agentId` and `action`. Operator approves a plan whose proposed `action: 'shell'` step shows command `"systemctl status nginx"`. Model later submits the actual call with `payload.command = "rm -rf /"`. `matchPlanStep` permits this — `command` is not in `KEY_FIELDS`.

The trust boundary is uncomfortably wide given the operator only saw the rationale text in `plan_proposed`.

**Fix.** For `dispatch_agent_command`, also pin `payload.command` (or `payload.scriptId` / `scriptContent`) into KEY_FIELDS when the plan step specifies them at propose time. The matcher must do deep equality. Alternatively, ALWAYS surface proposed payload AND actual payload in `plan_step_auto` SSE so divergences are operator-visible in real time.

---

### E3 — HIGH: SSE `approval_required` leaks raw `tu.input` (and audit log persists it)

**Where.** `src/services/ai-session.ts:386-389`.

When a Tier 3 call reaches the approval gate, `input: tu.input` is forwarded raw via `emitSse`. `compactToolResultForChat`'s secret-stripper runs only on tool **results**, never inputs. If a prior Tier 1 read surfaced a secret to the model (env vars, an SSH key, a stale secret in agent command history) and the model passes that secret as part of `payload.command` to a Tier 3 dispatch, the operator's UI receives the secret. The audit log row also stores `tool_input` cleartext (`stmtInsertToolExec.run`).

**Fix.** Run `compactToolResultForChat` (or at least `stripSecrets`) over `tu.input` before persisting it to `ai_tool_executions.tool_input` AND before emitting via SSE.

---

### E4 — HIGH: `maxTurnsPerSession` is never enforced

**Where.** `src/services/ai-session.ts:254-454` (no reference); `src/lib/server/db.ts:986` (default 50 seeded).

`postMessage` only enforces `MAX_TOOL_LOOP_ITERATIONS` (10) per turn and the monthly budget. Anything else can push the session past the documented 50-turn cap.

**Fix.** In `postMessage`, after `getSession`, refuse if `session.turnCount >= settings.maxTurnsPerSession`. Emit `{type:'error',error:'turn limit reached'}` and throw before consuming budget.

---

### E5 — HIGH: There is no API endpoint to set `ai` settings

**Where.** `src/routes/api/settings/+server.ts:22-31` `sectionSchemas` lists `general, company, invoices, proposals, emails, advanced, backup, remoteDesktop`. No `ai` (and no `rmm`, no `uptime` either — the latter has its own dedicated endpoint).

So either there's a hidden code path that adds `ai`, or the documented "Settings → AI" runbook entry is permanently inert. Both possibilities are bad: a hidden path likely lacks Zod validation and would let an attacker land arbitrary nested values in the AI block including an unencrypted `apiKey`.

**Fix.** Add `aiSettingsSchema` to `validators.ts` with strict types (`apiKey` `.min(0).max(256)`, model in an allowlist, `monthlyBudgetCents` clamped, `approvalMode` enum). Wire into `sectionSchemas`. Mask `apiKey` on read (B1) and accept `'***'` on write (preserve prior).

---

### E6 — MEDIUM: Anthropic model name is operator free-text — no allowlist

**Where.** `src/services/ai-session.ts:293`; `src/lib/server/ai/cost-tracker.ts:11-18`.

`MODEL_PRICING_CENTS_PER_MILLION_TOKENS` knows four models; anything else falls back to `DEFAULT_PRICING` (Opus rates). A future expensive model the operator types in (or an attacker poisons settings via E5) bills wrong.

**Fix.** `model: z.enum(Object.keys(MODEL_PRICING_CENTS_PER_MILLION_TOKENS))`. Or fail-closed (refuse turn) if pricing is undefined.

---

### E7 — MEDIUM: Monthly budget guard is read-then-write

**Where.** `src/services/ai-session.ts:268-272, 434`.

Two SSE turns started within ms (multiple tabs, scripted) both pass the budget check at $49.50 < $50 and both run.

**Fix.** Wrap budget check + claim-turn-slot insert into one `BEGIN IMMEDIATE` transaction. Process-local mutex also works since Node is single-process here.

---

### E8 — MEDIUM: Approval-gate Map is in-memory; restart leaves rows pending forever

**Where.** `src/lib/server/ai/approval-map.ts`, `src/services/ai-session.ts:390-391`.

Tier 3 call writes `ai_tool_executions.status='pending'`, registers an in-memory resolver. Server restart clears the Map; row stays `pending`. Operator approval flips to `approved`, `resolveApproval` returns `false` silently, audit log says "operator approved Tier 3" but nothing executed.

**Fix.** On startup sweep `ai_tool_executions WHERE status='pending'` and mark them `expired`. In approval handler, if `resolveApproval` returns `false` AND `created_at` is older than process start, return 410 Gone.

---

### E9 — MEDIUM: `sanitizeUserText` is ASCII-only — homoglyph bypass

**Where.** `src/lib/server/ai/sanitizer.ts:19-31`. 11 patterns are case-insensitive ASCII regex. Cyrillic `і` (U+0456) trivially bypasses `ignore previous instructions`.

**Fix.** NFKC normalise + Unicode confusables fold before regex match.

---

### E10 — MEDIUM: `sanitizePageContext` doesn't recurse

**Where.** `src/lib/server/ai/sanitizer.ts:68-82`. Only top-level string/number/boolean/array values are processed. Nested objects pass through verbatim. `{tabs:[{title:'…'}]}` skips sanitisation, then gets `JSON.stringify`d into the system prompt by `buildSystemPrompt` → direct prompt-injection vector.

**Fix.** Recurse with depth cap 4. For each non-string-non-array, drop or recurse.

---

### E11 — MEDIUM: Compact-secret-stripper misses Stripe / Twilio / SendGrid / Azure / GCP

**Where.** `src/lib/server/ai/compaction.ts:19-27`. Covers Anthropic, OpenAI, GitHub, AWS, Slack, JWT, PEM. A finding scan that returned a Stripe `sk_live_*` would leak it back to the conversation, audit log, transcript.

**Fix.** Add patterns for Stripe (`sk_live_…`), Twilio (`AC[a-f0-9]{32}`), SendGrid (`SG\.[A-Za-z0-9_-]{22}\.[A-Za-z0-9_-]{43}`), Azure connection strings (`DefaultEndpointsProtocol=…`), GCP service-account JSON markers (`"type":\s*"service_account"`).

---

### E12 — INFO: tier resolution, plan-mode pin enforcement at propose-time, tool-loop iteration cap, ownership checks all verified correct

`isKnownTool` uses `Object.prototype.hasOwnProperty.call`. Whitespace/case evasion (`'List_Agents'`, `' list_agents'`) all fail exact-match. ReDoS analysis on Anthropic-key + PEM regexes both linear sub-3ms. Reaper double-resolve safe (Promise resolution idempotent + `pending.delete(id)` before resolve). Every endpoint asserts `s.userId === locals.user!.id`. `propose_action_plan` 25-step cap enforced in code AND JSON schema. Plan auto-approve still calls `checkGuardrails` unconditionally.

---

## F. SSRF / NETWORK / EJS / PDF

### F1 — LOW: SMTP `pinnedLookup` skips `validateHostname`

**Where.** `src/services/emails.ts:60-68`. Calls `resolveAndValidate(hostname)` directly; the higher-level `resolveTarget` adds length/regex/IPv6-bracket sanity. `dns.lookup` rejects malformed values anyway, but defense-in-depth says route every callsite through `resolveTarget`.

**Fix.** Inside `pinnedLookup`, call `resolveTarget(hostname)` instead of `resolveAndValidate(hostname)`. Same for `validate-target.ts:140` (`resolveAndValidate` for the lookup-callback path).

---

### F2 — LOW: `monitorSchema.ip` regex accepts `999.999.999.999`-shape strings

**Where.** `src/lib/validators.ts:386-389`. `/^(\d{1,3}\.){3}\d{1,3}$/` doesn't bound octets to 0-255. Garbage reaches `dns.lookup` instead of being rejected at schema time. Not exploitable today; brittle.

**Fix.** Use `net.isIPv4(v) || net.isIPv6(v)` directly in the refine.

---

### F3 — LOW: SSL check uses `rejectUnauthorized:false` — intentional but creates a false-reassurance surface

**Where.** `src/lib/server/checks/ssl.ts:14`. Done so the check can read `cert.valid_to` for expired/self-signed certs. A network attacker can present any cert and have `daysRemaining` whatever they want — false telemetry signal, not data exfil.

**Fix.** Optional: also fetch with `rejectUnauthorized:true` and report cert-chain validity as a distinct metric.

---

### F4 — INFO: IPv4/IPv6 blocklist completeness, DNS-rebind defense, Puppeteer JS-disabled + data:-only request interception, EJS sandbox, SVG rejection across upload paths all verified correct

The `resolveAndValidate` covers IPv4 (private, loopback, link-local, multicast, broadcast, IETF reserved 240/4, documentation, CGNAT 100.64/10) and IPv6 (loopback, link-local, ULA fc/fd, IPv4-mapped ::ffff:0:0/96, NAT64 64:ff9b::/96, 6to4 2002::/16 with embedded check, Teredo 2001::/32 with XOR-decoded check, documentation 2001:db8::/32, multicast ff00::/8). Each redirect re-resolves and re-pins.

EJS sandbox: built-in trusted, custom path runs `validateTemplateSafety` rejecting `<%-` / `<%_` / non-allowlisted identifiers. Output context is prototype-free + deep-frozen. `setJavaScriptEnabled(false)` and `setRequestInterception(true)` aborting non-`data:` URLs apply to BOTH `generatePdf` AND `generateThumbnail` via `withPage`. SVG excluded from `verifyMagicBytes` and from logo / receipt MIME allowlists.

The HTTP monitor uses raw `http.request`/`https.request` which DON'T follow redirects by default — actually safer than CLAUDE.md's "max 5 hops" promise. RDAP DOES follow redirects with re-resolve+re-pin per hop.

---

## G. BACKUPS / REMOTE DESKTOP / GUACAMOLE

### G1 — HIGH: Backup `restoreBackup` is not atomic with the upload-dir swap

**Where.** `src/services/backups.ts:550-617`.

`db.transaction(...)` covers the SQL. The surrounding `ATTACH DATABASE`, `pragma foreign_keys = OFF`, the upload swap (`renameSync(UPLOAD_DIR, oldUploadDir); renameSync(tmpUploadDir, UPLOAD_DIR)`), and `recomputeAuditAnchor()` are NOT in the same atomic unit. Process kill (OOM, SIGKILL) between transaction commit and upload rename leaves the DB restored but uploads stale-or-missing. The rollback path only fires on a thrown error, not on hard process death.

**Fix.** (a) Take an automatic pre-restore snapshot to `_pre_restore_<ts>.zip` before the transaction. (b) Move the upload swap to *before* the SQL transaction so a swap failure aborts cleanly without DB mutation, OR fsync the upload-rename results before SQL transaction commit.

---

### G2 — HIGH: `previewRestore()` writes the plaintext temp DB at default umask

**Where.** `src/services/backups.ts:684-692`. Also covered as B6 — duplicating here so it's visible under backups.

**Fix.** Pass `{ mode: 0o600 }` to `writeFileSync`.

---

### G3 — HIGH: `restartGuacamoleProxy` is exposed but undocumented; no audit log

**Where.** `src/routes/api/remote-desktop/guacd/+server.ts:31-34`.

CLAUDE.md says the action allowlist is `'install'|'update'|'status'`. The code accepts `'restart'` and calls `restartGuacamoleProxy()` without `recordChange`. A logged-in operator (or CSRF-bypassing chain) issues `{action:'restart'}` and silently kills any in-flight remote-desktop session — no audit trail.

**Fix.** Either drop the `'restart'` case (it isn't documented), OR add `recordChange('settings', 'remoteDesktop', 'update', { guacdRestart: { old: null, new: true } }, locals.user.id)`. Update CLAUDE.md to match the actual surface.

---

### G4 — MEDIUM: WebDAV error-path may include credentials in bubbled error message

**Where.** `src/services/backup-offsite.ts:243, 318`; `src/routes/api/backups/offsite/+server.ts:33-37`.

Operator misconfigures WebDAV URL pointing at attacker.com (DNS resolves public IP, passes `resolveTarget`). Attacker server replies 401 with `WWW-Authenticate: Basic realm="<credential>"`. The body is capped at 64 KiB but headers aren't, and Node's `https.request` error path can include URL/headers under some debug configurations. SSRF-credential-confused-deputy.

**Fix.** Regex-strip `Basic [A-Za-z0-9+/=]+` from any error message bubbled to the response. Optionally: SPKI-pin per off-site target (operator pastes SPKI hash captured at first upload).

---

### G5 — MEDIUM: Restore audit-log uses `INSERT OR IGNORE` — silently drops conflicting rows

**Where.** `src/services/backups.ts:592, 595`.

A backup whose audit log was tampered to match prefixes of the current chain — or just a backup that pre-dates intervening operator activity — silently loses cleanup audit entries on restore. Anchor still verifies because `recomputeAuditAnchor()` runs after.

**Fix.** Either `DELETE FROM main.changes` before insert (matching the pattern other tables use on line 572), OR document explicitly in the runbook that restored audit chains *append with conflict-drop* semantics.

---

### G6 — MEDIUM: Off-site upload pinned-IP TLS uses default Node CA bundle without optional CA pinning

**Where.** `src/services/backup-offsite.ts:27-38`. CA-trusted MITM (rogue CA, malicious enterprise root) intercepts the off-site upload. S3 SigV4 protects body integrity; WebDAV path's Basic auth is plaintext.

**Fix.** Optional SPKI pin per off-site target — operator pastes hash captured at first upload. Mirrors the agent's `--pin-tls` pattern.

---

### G7 — LOW: `convertRecording` `guacenc` MP4 output unbounded by size

**Where.** `src/services/guacamole.ts:335`. `runArgv` stdout/stderr capped at 4 MiB; the MP4 output file isn't. Multi-hour 1280x800@4M session → multi-GB MP4. Disk DoS by long sessions.

**Fix.** Max-recording-size guard that aborts conversion past (e.g.) 2 GB. Or skip when free disk falls below threshold.

---

### G8 — INFO: encrypted Guacamole token contains no credentials, double-CAS race protection on session tokens, WebSocket Origin enforced, guacd loopback default, AAD-bound per-agent password, `lastUpload` schema-stripped, passphrase elision on the correct field

`encryptGuacToken({ connection: { type: profile.protocol, settings: {} }, itcakeSessionId: session.id })` — settings literally empty. `consumed_at IS NULL` CAS at SQL level + `started_at IS NULL` CAS on WS-upgrade make double-use race-impossible. `verifyClient` rejects empty/null Origin and requires exact equality in production. AAD format `agent.remoteDesktop.{password,privateKey}:<id>` (caveat: agent IDs with `:` would alias — see B7 for the analogous concern).

---

## H. GO RMM AGENT

The Go agent runs as root (Linux/macOS) or LocalSystem (Windows). Compromise = full host takeover.

### H1 — CRITICAL: PATH hijack of system tools invoked unqualified

**Where (multiple):**
- `agent/internal/peripheral/enumerate_darwin.go:21` — `system_profiler`
- `agent/internal/peripheral/enumerate_linux.go:100` — `udevadm`
- `agent/internal/peripheral/enumerate_windows.go:23` — `wmic`, `powershell`
- `agent/internal/eventlog/eventlog_*.go` — `journalctl`, `log`, `wevtutil`
- `agent/internal/bootperf/bootperf_*.go` — `log`, `sysctl`, PowerShell `Get-WinEvent`
- `agent/internal/cis/checks_*.go` — `defaults`, `systemsetup`, `spctl`, `csrutil`, `sshd`, `modprobe`, `lsmod`, `sysctl`, firewall tools, `powershell`
- `agent/internal/hwinfo/hwinfo_darwin.go:22` — `system_profiler`
- `agent/internal/reliability/collector_darwin.go:21` — `log`
- `agent/internal/packages/pip.go:40` — `python3 -c`

`agent/internal/commands/extendedEnv()` aggressively prepends user-writable directories — `/opt/homebrew/bin`, `/usr/local/bin`, `/snap/bin`, `$HOME/.local/bin`, `$HOME/.nvm/current/bin`, `$HOME/go/bin` — to PATH. With agent running as root and PATH like that, every unqualified `exec.Command("foo", ...)` is a console-user-to-root escalation primitive: a non-admin attacker plants `/opt/homebrew/bin/system_profiler` (a script that prints attacker JSON, optionally `kill $$` and replace itself), the agent (root) runs it. On macOS Homebrew is writable by the console user by default — this is a one-step LPE.

**Fix.** Pin every tool to its absolute path. Pattern already used safely in `config/config.go:338, 351-352` for machine-id readers. Concrete fixups:
- macOS: `/usr/sbin/system_profiler`, `/usr/bin/log`, `/usr/sbin/sysctl`, `/usr/bin/defaults`, `/usr/sbin/systemsetup`, `/usr/sbin/spctl`, `/usr/bin/csrutil`, `/usr/sbin/sshd`, `/usr/sbin/fdesetup`.
- Linux: `/usr/bin/journalctl`, `/usr/sbin/sysctl`, `/usr/bin/lsmod`, `/usr/sbin/udevadm` (with `/sbin/udevadm` fallback).
- Windows: `filepath.Join(getSystemRoot(),"System32","wbem","wmic.exe")`, `…\System32\WindowsPowerShell\v1.0\powershell.exe`, `…\System32\wevtutil.exe`.

---

### H2 — HIGH: Package-manager builders concatenate `pkg` into shell command strings

**Where.** `agent/internal/packages/{apt,dnf,pacman,apk,npm,pip,brew,winget,choco,scoop,apps_darwin}.go`.

Each returns `"apt-get install -y " + pkg` etc., passed to `commands.Execute(cmdStr, timeout)` → `/bin/sh -c <cmdStr>`. Defense is `pkgNameRE` (`util.go:26`) which forbids spaces/quotes/etc. and currently allows `/`, `:`, `+`, `@`, `_`, `.`, `-`. None of those individually enable shell escape, so this is **safe today** — but every builder does its own concatenation, so a single regex relaxation = RCE on every endpoint, and the regex is the only guard.

**Fix.** Change every `Manager` interface method to return `(name string, args []string)` instead of `string`. Dispatch calls `ExecuteArgvAsRoot` directly — no shell. Where `&&` chaining is needed (`apt-get update && apt-get install -y`), route through `bash -c "$1 && $2" bash "$pkg"` — bash treats `$1` as a positional, no metacharacter interpretation.

---

### H3 — HIGH: replay-cache.json is unbounded + corruption silently fails-open

**Where.** `agent/internal/commands/replay.go:38-103`, `:67-68`.

- `Check()` calls `persistLocked()` per accepted command — full JSON rewrite per call.
- Map pruned only on `len > 2048`; if server pumps commands faster than 2048 / 30 min, cache grows unbounded.
- On corrupt JSON, `Unmarshal` error is silently ignored and the replay set restarts empty.

Local user with brief filesystem write to `/etc/itcake-agent/replay-cache.json` plants `{}`. On agent restart (or any operation that triggers reload), all previously-seen commands are valid again for the next 10 min.

**Fix.**
- Hard cap `len(r.m)` at 8192. Evict oldest by timestamp before adding new.
- HMAC the cache file under `cfg.HMACSecret` and reject MAC mismatch on load. Parse error or MAC mismatch → log loudly, refuse all commands until operator clears state.
- Use `os.OpenFile(tmp, O_CREATE|O_RDWR|O_EXCL, 0o600)` instead of `WriteFile` + post-`Chmod` (closes the brief 0o644 window if umask is 022).

---

### H4 — MEDIUM: Reboot-message argv path safe but comment hints at instability; Windows `svcctl` uses `cmd.exe /d /s /c` with `&` chaining

**Where.** `agent/internal/checkin/checkin.go:701-737` (reboot — currently safe via argv, but the comment says "the previous behavior" suggesting prior shell pattern).
`agent/internal/commands/svcctl.go:60-72` (Windows restart: `sc.exe stop "%s" & sc.exe start "%s"`). Defense is `serviceNameRe` (`A-Za-z0-9._@-`).

Today both safe. Risk class: regression-only.

**Fix.** Replace `&`-chained command in `svcctl.go` with a stop-poll-start sequence using separate `ExecuteArgvAsRoot` calls. Add a regex strip at the agent reboot-message layer mirroring the server validator.

---

### H5 — MEDIUM: `SecureString.Zero` may be optimised away

**Where.** `agent/internal/secmem/secmem.go:84-94`.

Loop sets bytes to 0 then assigns nil. Without `runtime.KeepAlive(s)` or `//go:noinline`, compiler is free to elide writes. Go 1.x compilers don't currently dead-store-eliminate slice writes aggressively, but worth annotating.

**Fix.** Add `//go:noinline` directive immediately above `func (s *SecureString) Zero()` and `Replace()`. Add `runtime.KeepAlive(s)` after the loop.

---

### H6 — INFO: HMAC verification, signature-before-execute ordering, self-update flow (hash check BEFORE smoke-test BEFORE rename), TLS pinning, machine-id config crypto, Ed25519 manifest sig, future-9min-skew rejection all verified correct

`hmac.Equal` constant-time. Signature is verified before payload JSON decode (`checkin.go:377` ordering correct). Self-update at `checkin.go:1306-1316`: SHA-256 verify → smoke test → atomic rename. ETXTBSY mitigation by `os.Remove` of live binary on Linux/macOS before rename. `±10 min` skew window correctly rejects future-9-min via `time.Since(t) < -time.Minute`. Manifest pubkey loader fails closed when `len(decoded) != 32`. `--insecure` is enrollment-only and never persisted. Config encryption fail-closed if machine-id unreadable.

---

## I. SQL / DOCUMENT-STORE / VALIDATORS / FRONTEND XSS

### I1 — HIGH: `documents.type` CHECK omits `custom_field_def` and `saved_filter`

**Where.** `src/lib/server/db.ts:49` (initial), `:843` (rebuild), `:886-896` (probe loop). Consumers: `src/services/{custom-fields,saved-filters}.ts`.

The CHECK constraint allows only `IN ('invoice','proposal','client','unit','catalog_item','template','expense','ticket')`. The TS `DocumentType`, `ChangeEntityType`, `BACKUP_VALID_DOCUMENT_TYPES`, and the consumers all use `'custom_field_def'` and `'saved_filter'`. The probe loop only tests existing types, so the rebuild branch never triggers for the missing types. Calling `createCustomField()` or `createSavedFilter()` on a fresh-from-this-build DB throws `CHECK constraint failed: documents`.

**Fix.** Update both CHECK clauses to include `'custom_field_def'` and `'saved_filter'`. Add probe entries `['__type_check_custom_field_def__','custom_field_def']` and `['__type_check_saved_filter__','saved_filter']` at line 886. Add an integration test creating a custom field + saved filter.

---

### I2 — MEDIUM: Saved-filter and custom-field-def JSON not re-validated on read

**Where.** `src/lib/server/filter-fields.ts:88-112`, `src/services/saved-filters.ts:40-43`, `src/routes/api/agents/+server.ts:38`.

Stored JSON is `JSON.parse`'d and cast (`saved.conditions as FilterCondition[]`) without re-running the Zod schema. A tampered DB / restored-from-evil-backup row reaches the filter engine bypassing schema. `compileFilter` does throw on unknown fields/operators (`filter-engine.ts:98, 101`) so SQL injection is blocked, but a future refactor of the registry could lose protection.

**Fix.** In `rowToFilter` and `readCustomFieldDefs`, run the corresponding `safeParse`. In `routes/api/agents/+server.ts:38`, run `inlineFilterSchema.safeParse(saved.conditions)` before passing to `queryAgentsFiltered`.

---

### I3 — MEDIUM: Settings sections `uptime`, `rmm`, `ai` are accepted by `updateSettingsSection` but missing from `sectionSchemas`

**Where.** `src/routes/api/settings/+server.ts:22-31` vs `src/services/settings.ts:66-69`.

`VALID_SETTINGS_KEYS = BACKUP_VALID_SETTINGS_KEYS` includes `uptime`, `rmm`, `ai`. `sectionSchemas` doesn't. Today the extra keys are rejected at the API layer, so they're functionally inert from `/api/settings` — but if anyone wires a future endpoint via `updateSettingsSection('ai', body)` without first running Zod, deep-merge accepts arbitrary nested values.

**Fix.** Either remove `rmm`/`ai` from `BACKUP_VALID_SETTINGS_KEYS` until UIs/endpoints land, OR add explicit schemas. Add a startup invariant: every section in `BACKUP_VALID_SETTINGS_KEYS` must have a Zod schema applied before `updateSettingsSection`.

---

### I4 — INFO: Frontend XSS surface verified clean

- `grep -rn '{@html'` returns exactly one hit: `src/components/tickets/TicketCard.svelte:95` — and the source `ticket.description` is sanitized at write time via `sanitizeRichText` (`tickets.ts:139, 175`) and re-sanitized at restore time (`backups.ts:316`). The `sanitize-html` allowlist is tight (`b/i/u/strong/em/br/p/ul/ol/li/span/div/sub/sup` only; `style` only on `span/p/div` with bounded regex on `text-align/decoration/font-weight/font-style`). **Verified safe.**
- No `innerHTML`/`outerHTML`/`insertAdjacentHTML`/`document.write` outside of `RichTextArea.svelte`'s own sanitised-DOM read.
- No `eval(` / `new Function(` anywhere in `src/`.
- No `javascript:` URL in any `<a href={…}>`.
- All dynamic href bindings resolve to hardcoded path constants or server-supplied IDs.
- `RichTextArea` paste handler: `DOMParser` to detached `text/html`, walks nodes, drops everything not in `ALLOWED_TAGS = {B,STRONG,I,EM,U,UL,OL,LI,BR,P,DIV,SPAN}`. No attribute pass-through.

---

### I5 — INFO: SQL injection surface clean

All `db.prepare()` calls use `?` parameter binding. Template-literal SQL (`db.prepare(\`…\`)`) interpolates only schema-controlled identifiers (e.g. table names from a hardcoded allowlist in `replaceTables`). `queryDocumentsPaginated` runs `SAFE_FRAGMENT_RE` + `FORBIDDEN_FRAGMENT_RE` + placeholder-count parity check on every fragment. `compileFilter` runs `SAFE_COLUMN_RE` + `FORBIDDEN_COLUMN_RE` per column. LIKE escaping uses the standard `escapeSqlLike`/`escapeLikeLiteral` helpers paired with `ESCAPE '\\'`. All `json_extract` paths use hardcoded `'$.field'` literals.

---

### I6 — INFO: Counter race conditions, audit log integrity

`incrementCounter` and `incrementCounterWithMin` are wrapped in `db.transaction()` (`db.ts:1296, 1303`). better-sqlite3 + WAL serialises writes per connection. No race in `createInvoice` between two concurrent calls.

`recordChange` uses parameter binding only. Hash is HMAC-SHA256 over a length-prefixed encoding (`changes.ts:56-77`) — robust against field-boundary collisions. `verifyAuditLogIntegrity` uses `crypto.timingSafeEqual`.

---

## J. Code-quality observations (non-security, requested)

### J1 — Cluttering / incomplete comments

- `src/services/auth-mfa.ts:97` — `// Persisting MFA state and revoking pre-MFA sessions MUST be atomic —` ends with a dash and trails off. Either complete or delete (CLAUDE.md says comments are off by default).
- `src/lib/server/db.ts:1251` — `// returns it directly, so callers must NOT mutate the returned value` is severed from the `getSetting` it documents (function starts at 1254). Move directly above `export function getSetting` or delete (the rule is enforced by `structuredClone` in `getAllSettings` anyway).
- `src/lib/server/changes.ts:28-55` — 28-line function-level docstring. Substantive content (encoding rationale, length-prefix justification, v0/v1 split) is load-bearing; keep — but the development-fallback paragraph duplicates `macOrSha`'s code; trim.
- Sticky asserts that ARE worth keeping:
  - `services/auth-mfa.ts:209` — `// don't break — keep work proportional to hashes.length` (timing equality rationale).
  - `services/settings.ts:14` — `// structuredClone so masking below doesn't mutate getSetting's cache.` (cache-invariant).

### J2 — Console output

`console.info('[guacamole] proxy listening …')`, `console.log('[agent-build] …')`, `console.error('Recurring invoice processing failed:', e)` etc. are operator-visible startup/failure signals — keep. No stray `console.log` debug statements found.

### J3 — Tests covering the highlighted bugs

`tests/integration/lifecycle.test.ts` and `tests/unit/*.test.ts` exist. Neither covers (in priority order):
- Captured-mfaToken replay (A2) — assert that a wrong-password attempt with mfaToken consumes it.
- enableMfa-without-currentPassword (A1) — assert `{action:'enable'}` without `currentPassword` is rejected once the fix lands.
- `ai.apiKey` masking on `GET /api/settings` (B1).
- Settings credentials encrypted as enc3 with AAD (B2).
- CSV formula injection (C2) — easy to add `tests/unit/csv.test.ts`.
- Action-allowlist prototype-chain (C3) — assert POST `{action:'__proto__'}` returns 400, not 500.
- `documents.type` CHECK includes `custom_field_def` and `saved_filter` (I1).
- `recomputeAuditAnchor` refuses to shrink `row_count` (B3).
- Plan-mode auto-approve refuses divergent `payload.command` (E2).

CLAUDE.md says "Every behavior change ships with a test … No exceptions." When fixing any of the above, ship the regression test in the same PR.

### J4 — Docs/code drift in CLAUDE.md

- "settings.ai.apiKey field-encrypted via enc3: with AAD ai.apiKey:1" → reality is enc2 (B2).
- "Strict-mode rejection of plaintext-downgrade (same as SMTP/Telegram credentials)" → strict-mode IS implemented (`db.ts:1207-1210`); the AAD-binding part isn't.
- "Settings → AI to use" runbook → no API endpoint exists (E5).
- "50 turns per session, 10-iteration tool loop cap" → only the second is enforced (E4).
- "bearer-only on /api/rmm/* (CSRF-exempt)" → `/api/rmm/update-manifest-key` is cookie-auth (C1).
- "HSTS includes preload in prod" → also sent under `NODE_ENV=test` (C7).

### J5 — Dead / inconsistent code

- `agent/internal/packages/apps_linux.go:7` — `IsAvailable() = false` so `DetectManagers` never includes it on Linux; but `checkin.go:561-563` has a code branch keyed on `mgr.Name() === 'apps'` that's unreachable on Linux. Drop the stub or wire it as an explicit no-op error.
- `src/lib/server/ai/approval-map.ts:59-63` — `pendingCountForSession` exported but no caller. Dead code; remove or wire to a UI surface.
- `agent_schedules.cron_expression` is captured as `z.string().min(1).max(100)` with no syntactic refine (`validators-rmm.ts:412, 424`). If parser-side validation isn't already on the agent, add `.refine(s => parseCron(s) !== null)`.

---

## K. Items confirmed safe (informational, no action)

- IPv4/IPv6 SSRF blocklist completeness (F4).
- DNS-rebind defense via per-call resolve-and-pin (HTTP/SSL/RDAP/SMTP/backup-offsite).
- Puppeteer JS-disabled + data:-only request interception in BOTH PDF and thumbnail paths.
- EJS sandbox + `<%- … %>` rejection for custom templates + prototype-free deep-frozen context.
- Single-use remote-desktop token via two-stage CAS (`consumed_at` → `started_at`) — race-safe.
- Encrypted Guacamole token contains no credentials (settings explicitly empty).
- WebSocket Origin enforced on guacd-proxy upgrade — equivalent to REST CSRF.
- guacd binds 127.0.0.1 by default.
- Per-agent remote-desktop password AAD-bound (`enc3:` with `agent.remoteDesktop.{password,privateKey}:<id>`).
- Counter increments inside `db.transaction()` — concurrent-create race-safe.
- Audit-log HMAC chain canonical encoding is length-prefixed (v1) — robust against field-boundary collisions.
- `verifyAuditLogIntegrity` uses `crypto.timingSafeEqual`.
- Recovery codes hashed at rest with HMAC-SHA256.
- Origin/Referer CSRF logic correct (exact-equality, missing-Origin → fallback to Referer → fail, "null" Origin rejected).
- Cookie hardening (HttpOnly, Secure-in-prod, SameSite=Strict).
- Deep-merge prototype-pollution defense (BANNED_KEYS at every depth).
- Full `grep -rn "{@html"` returns one safe hit.
- All `json_extract` paths use hardcoded `'$.field'` literals; LIKE uses `ESCAPE '\\'`.

---

## L. Direct verifications performed (file:line read)

✅ `enable` MFA action takes no `currentPassword` — `routes/api/auth/mfa/+server.ts:41-52`.
✅ `consumeMfaChallenge` is the last gate in `login/+server.ts:35`, after password+TOTP checks.
✅ `encryptSettingsFields` calls `encryptField(v)` with no AAD at `db.ts:1234, 1242, 1244, 1246, 1247`.
✅ `field-crypto.ts:55` — `prefix = aad ? PREFIX_V3 : PREFIX_V2`.
✅ `update-manifest-key` is at `/api/rmm/` and uses `handleActionPost` (cookie auth) at `routes/api/rmm/update-manifest-key/+server.ts:13`.
✅ `validateOrigin` returns early for `/api/rmm/*` at `hooks.server.ts:123`.
✅ `recomputeAuditAnchor` at `changes.ts:176-182` writes unconditionally; no row-count guard.
✅ `chainHashV0` accepted alongside v1 in the verifier loop at `changes.ts:217-223`.
✅ `csv.ts:13-32` — formula prefix not handled.
✅ `request-utils.ts:113` — `action in config.actions` walks prototype chain.
✅ `request-utils.ts:11-13` — `text/json` accepted, missing CT slips through.
✅ `login/+page.server.ts` form action skips `recordAttempt` on Zod fail.
✅ `services/settings.ts:9-36` — masking switch covers SMTP/Telegram/backup creds; **`ai.apiKey` is not masked**.
✅ Deep-merge prototype-pollution defense at `services/settings.ts:43-64` is correct.
✅ All `json_extract` SQL paths are hardcoded; LIKE uses `ESCAPE '\\'`.
✅ Ticket descriptions sanitised at write time via `sanitizeRichText`; `{@html}` used in TicketCard is therefore safe.
✅ `documents.type` CHECK at `db.ts:49` lacks `custom_field_def` and `saved_filter`.
✅ `pickPresentKeys` at `request-utils.ts:50-59` uses `key in parsed`.

---

## M. Recommended fix priority order

1. **B1 / E1** — mask `ai.apiKey` in `getAllSettings`; add `aiSettingsSchema` to `sectionSchemas` (one-line + new schema).
2. **A1** — require `currentPassword` in `enable` MFA action.
3. **H1** — pin absolute paths for `system_profiler`/`journalctl`/`log`/`sysctl`/`wmic`/`powershell` etc. across the Go agent.
4. **A2** — move `consumeMfaChallenge` to immediately after `verifyMfaChallenge`.
5. **B2** — plumb AAD through `encryptSettingsFields`/`decryptSettingsFields`; add migration.
6. **C1** — move `update-manifest-key` out of `/api/rmm/` (or add explicit Origin check).
7. **B3** — guard `recomputeAuditAnchor` against shrinking row counts; add an installation-salt to chain+anchor.
8. **I1** — add `custom_field_def` and `saved_filter` to `documents.type` CHECK and probe loop.
9. **E2 + E3 + E4** — pin `payload.command` in plan-auto matcher; redact `tu.input` for SSE+audit; enforce `maxTurnsPerSession`.
10. **H2** — migrate package-manager builders from string concat to `(name, args)` argv.
11. **G1 + G2** — atomic backup restore (pre-restore snapshot + ordered swap); chmod 0o600 on `previewRestore` temp DB.
12. **C2** — CSV formula-prefix neutralisation in `escapeCell`.
13. **C3 + C6** — replace prototype-chain `in` checks with `Object.prototype.hasOwnProperty.call`.
14. **D1 + D2 + D3** — audit-log enrollment-token mint; cap concurrent active tokens; rate-limit checkins.
15. Lower-priority items follow.

When fixing, each change ships with a regression test (CLAUDE.md mandate).
