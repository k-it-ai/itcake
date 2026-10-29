# Test Plan — Static Verification Results

Walking through `docs/test-plan.md`. The original pass verified each test by
code inspection; later passes added the production integration suite and the
opt-in live suite under `tests/live/`. Marks:

- ✅ **PASSED** — defense exists in code and works as expected
- 🛠️ **FIXED** — issue found and patched during this run
- ⚠️ **NEEDS LIVE TEST** — code looks right but final verification needs
  a running server / VM
- ❌ **FAILED** — defense is broken; bug filed

Baseline: 1,416 TypeScript tests across 129 files pass, all Go packages pass.
The counts below record the original audit run; the totals were re-verified
after the production-hardening pass (`tests/integration/production.test.ts`)
and the opt-in live suite (`tests/live/`, PR #128).

## Linux ARM64 deployment validation (2026-10-29)

Environment: Debian 13 (trixie) aarch64 in Lima, 2 vCPU / 3 GiB RAM, Node
22.23.4, Go 1.27.3, Caddy 2.6.2, Chrome for Testing 156.0.8078.47.

- `npm run check` — 0 errors, 0 warnings.
- `npm test` — 1,416 passed across 129 files (with `build/index.js` present).
- `npm run build` — success.
- `npm run test:live` — 37 passed, 3 skipped on Linux ARM. The skips were
  Telegram (2) and Anthropic (1), which need disposable credentials. guacd ran
  against a locally built guacd 1.6.0 and a loopback SSH target. The Telegram
  test was then run separately on the macOS host with a disposable bot:
  2 passed, including a real `sendMessage` delivery.
- `install.sh` — installed into a clean data directory, generated a valid
  systemd unit, enabled and started `itcake.service`; Caddy served
  `https://localhost` with HSTS and a Secure session cookie; `/api/healthz`
  reported database, disk, and Puppeteer `connected`.
- Cold reboot (`limactl stop` / `start`) — `itcake.service` and `caddy.service`
  came back automatically and the HTTPS health check passed.

Issues found and fixed during this run:

- `install.sh` wrote shell-style quotes around `WorkingDirectory=`,
  `EnvironmentFile=`, and `ReadWritePaths=` in the systemd unit. systemd treats
  the quotes as part of the path and refused to start the unit. The installer
  now writes unquoted paths and rejects whitespace in the install/Node paths.
- `tests/live/caddy-tls.test.ts` collided with a host Caddy service on the
  admin port (`127.0.0.1:2019`) and port 80. The test now disables the admin
  endpoint and automatic HTTP-to-HTTPS redirects in its isolated Caddyfile.

---

## §1 First-time setup 🔴

- **1.1** Empty-DB redirect chain — ✅ `routes/+page.server.ts:7` + `routes/login/+page.server.ts:14` both redirect to `/setup` on `!hasUsers()`.
- **1.2** Three-step form happy path — ✅ `routes/setup/+page.server.ts` applies company (l.83), general+tz (l.99), invoices (l.105), proposals (l.109); auto-login (l.55).
- **1.3** Two-tab race — ✅ `createFirstUser` in `db.ts:1566` is wrapped in `db.transaction`; SELECT count + INSERT atomic; loser returns false → throws `REGISTRATION_CLOSED`.
- **1.4** Setup rate limit — ✅ `setup:<ip>` bucket via `checkAndRecordSetupAttempt`, cap=10 / 15min.
- **1.5** JSON register without company — ✅ `/api/auth/register:40` returns `setupComplete: false` + note.
- **1.6** JSON register with company — ✅ `updateSettingsSection('company', ...)` applied; `company.email` defaults to operator email so `isSetupComplete()` returns true.

---

## §2 Auth + session 🔴

- **2.1** Cookie attrs — ✅ HttpOnly, SameSite=Strict, Secure (in prod), Path=/, maxAge=SESSION_MAX_AGE. Token = 64-lowercase-hex.
- **2.2** Token regex gate — ✅ `auth.ts:116` `/^[0-9a-f]{64}$/.test()` blocks malformed cookies before HMAC lookup.
- **2.3** Session rotation CAS — ✅ `auth.ts:131-142` rotates when `remainingSec < SESSION_MAX_AGE - SESSION_EXTEND_THRESHOLD`; `stmtRotateSession.changes === 1` is the CAS; loser fails closed.
- **2.4** Logout — ✅ `auth.ts:155` deletes by hashed token + clears cookie.
- **2.5** Timing-equalised email lookup — ✅ `auth.ts:81` runs bcrypt against DUMMY_HASH on missing user (no early return).
- **2.6** SQL injection — ✅ prepared statement; param-bound.
- **2.7** Password change requires currentPassword — ✅ `auth.ts:187` throws on wrong currentPassword BEFORE applying new hash.
- **2.8** Password change revokes sessions — ✅ `updatePasswordAndRevokeSessions` runs `stmtDeleteUserSessions` inside the tx.

---

## §3 MFA / TOTP 🔴

- **3.1** Enroll TOTP — ⚠️ code path verified (`enableMfaTx`); ENROLL flow needs live UI test.
- **3.2** Login with MFA happy path — ⚠️ code reviewed; needs live UI.
- **3.3** mfaToken replay — ✅ `consumeMfaChallenge` CAS via mfa_used_challenges unique constraint; first attempt burns regardless of TOTP outcome.
- **3.4** Step-2 separate bucket — ✅ verified by `tests/unit/loop14-followups.test.ts` (4 cases pass).
- **3.5** Recovery code consumption — ✅ `consumeRecoveryCode` runs constant-time per-element (`crypto.timingSafeEqual`) with no early break; atomic consume tx.
- **3.6** Step-up replay cache — ✅ `markTotpUsed` PK collision → false; `mfa-stepup:<userId>` bucket caps 5 failures/15min; success clears bucket.
- **3.7** Disable MFA requires currentPassword — ⚠️ code path uses `requireMfaStepUp` + password verify; needs live test.

---

## §4 CSRF / Origin gate 🔴

✅ **All 11 cases pass** via `tests/unit/csrf-validate-origin.test.ts`:
GET/HEAD/OPTIONS exempt; `/api/rmm/*` + `/api/csp-report` carve-outs; Origin match; cross-origin 403; Referer fallback (matching, mismatching, malformed); http vs https scheme; port mismatch.

---

## §5 Settings credentials 🔴

✅ **All 21 tests pass** via `settings-audit-mask.test.ts` (8 credentials × mask-on-GET + mask-preserve-on-POST + audit-log mask) + `settings-paths-parity.test.ts` (rotation script in sync with SETTINGS_CREDENTIAL_AADS). Cross-row AAD substitution covered by `security-hardening.test.ts`.

---

## §7 RMM command dispatch 🔴

✅ All 19 Go `commands` package tests pass: signature HMAC + constant-time, empty-secret-fail-closed, ±10min freshness, future-skew rejection, payloadRaw verbatim (no re-marshal), missing-field validation, replay cache duplicate-blocking.
✅ Cross-agent guard verified via `loop16-coverage.test.ts` (`processCommandResult` `WHERE agent_id = ?` predicate refuses victim's commandId from attacker).
✅ Transient-nack protocol verified via `transient-nack.test.ts` (5 cases).
✅ Service-action argv-form verified via `svcctl_test.go` (11 cases incl. shell-metachar rejection).
✅ End-to-end enroll → check-in → dispatched command → result verified by
`tests/live/agent-smoke.test.ts` on macOS, Linux, and Windows (the Windows
run is part of CI). Real shell timeout/process-group kill remains covered by
the Go command tests.

---

## §11 Remote desktop 🔴

✅ `consumeRemoteSession` single-use CAS, expired-token rejection, malformed-token safety verified via `loop16-coverage.test.ts` (3 cases).
✅ `claimRemoteSessionStart` start-time CAS verified earlier.
✅ `verifyClient` Origin + HMAC envelope rejection paths all logged via single `reject(reason)` helper (loop-15 #17).
✅ Real guacd SSH and RDP sessions verified through the production WebSocket
proxy by `tests/live/guacd.test.ts` (§11.1, 11.3, 11.8): token HMAC, one-time
session claim, protocol check, display defaults, and connect/disconnect
lifecycle. The test requires an externally provisioned guacd and target and
skips otherwise; ITCake itself remains bare-metal/VM only.

---

## §12 Invoices + money 🔴

✅ **44 tests pass** via `money.test.ts` (integer-cents discipline, 3-tax-group remainder absorption to largest group, computeInvoiceTotals reconciliation, float-drift on save-reload, edge cases) + `invoice-status-transitions.test.ts` (all 5×5 transition matrix cells: draft/sent/paid/overdue/cancelled).
✅ paidDate uses `operatorTodayDate()` (loop-13 fix verified via `operator-tz-today.test.ts`).
✅ Recurring invoice clone via `structuredClone` (loop-14 verified).
✅ Credit-note sticky `creditNoteIssuedAt` marker.
✅ Real PDF rendering (§12.7) verified by `tests/integration/production.test.ts` with Chromium's sandbox enabled.

---

## §18 Backups 🔴

✅ **49 tests pass** across 10 backup-*.test.ts files: crypto round-trip (v1+v2 headers + explicit version check from loop-12), encrypted-zip self-decrypt rejected (passphrase elided from in-zip settings), restore allowlists (column mapping, no triggers/views), retention (keepMin + retentionDays), allowlists parity, counter cross-check, zip-bomb preview-only, settings carry-over.
✅ Passphrase rotation re-encrypts every `.zip.enc` atomically (loop-12).
✅ Cross-key restore verified by `tests/live/cross-key-backup.test.ts`
(§18.5): backup from host A restored under a different
`FIELD_ENCRYPTION_KEY`/`SESSION_SECRET`; plaintext business data survives,
encrypted credentials and SESSION_SECRET-keyed recovery hashes fail closed.
A physically separate host is still the only untested variant, but the
key-rotation failure mode is covered.

---

## §19 Audit log 🔴

✅ **23 tests pass** via `audit-chain.test.ts` (forgery → tampered, truncation → tail-truncated, mid-chain edit → tampered, anchor history HMAC bound to captured_at) + `audit-prune-anchor.test.ts` (post-prune anchor=ok, history trim suppresses false-positive, negative-control proves trim is load-bearing).
✅ Pre-rotation rows marked `tampered` correctly.

---

## §26 SESSION_SECRET rotation 🔴

✅ **4 tests pass** via `rotate-session-secret.test.ts` (re-wraps every `enc3:` blob, refuses identical OLD==NEW, dry-run leaves DB untouched) + `settings-paths-parity.test.ts` (script's SETTINGS_PATHS in sync with `SETTINGS_CREDENTIAL_AADS`).
✅ Enrollment tokens cleared on rotation (loop-15 fix).

---

## RMM-focused: complete

### §6 Agent enrollment 🟠

✅ `enrollAgent` is one `db.transaction` (services/agents.ts:234); token lookup + expiry + hostname collision + mark-used + agent insert are atomic. Tests in `rmm-enroll-manifest-pubkey.test.ts` (2 cases) cover the new pubkey persistence path.
✅ Real enroll + check-in verified by `tests/live/agent-smoke.test.ts` on
macOS, Linux, and Windows. Collision/token-reuse paths are covered by unit
tests. The SPKI pin is covered by real-TLS Go tests in
`agent/internal/checkin/tls_test.go`: matching leaf accepted, a different leaf
from the same trusted CA rejected, a CA SPKI rejected in place of the leaf, and
unpinned chain verification still enforced. A full mitmproxy run is optional
external confirmation, not a code-level gap.

### §8 RMM self-update 🟠

✅ HMAC advisory + Ed25519 manifest verify covered by `updater_test.go` (9 cases) + `advisory_replay_test.go` (3 cases). Probe + atomic rename (ETXTBSY fallback) + Windows ACL re-apply covered.
⚠️ Real-binary-substitution attack + CDN-MITM need live network test.

### §9 RMM telemetry collectors 🟠

✅ All collector Go packages pass (secscan, peripheral, cis, netdisc, reliability, filescan, bootperf).
✅ Sysfs 8KB cap (loop-15) + RunCappedOutput helper for malicious-peripheral protection.
⚠️ Real malicious-USB / fake-SSN / network-discovery scenarios need live VM.

### §10 Alert rules + auto-actions 🟠

✅ **30 tests pass** via `alert-rules.test.ts` + `alert-actions.test.ts`. Includes filesystem_cleanup excluded from alertActionSchema, cooldown `last_fired_at` CAS, dispatch-before-audit ordering (loop-10), and discriminator-union validation.

---

## Critical + RMM pass: COMPLETE

**Static verification: every code path defended.** Of the 53 test-plan items:
- **All critical and RMM items are unit-test-backed and pass**
- **The main flows are also exercised end-to-end** against the real production build: setup/auth (§1-§2), agent enroll/check-in/command/revocation on macOS, Linux, and Windows (§6-§7, §28.1), guacd SSH/RDP (§11), receipt uploads (§16), cross-key restore (§18), uptime HTTP/TLS/RDAP probes (§21), SMTP (§22), health and rate limits (§23-§24), and CSP (§25)
- **Partially tested or external items are listed in the table below.** The
  remaining items are optional external confirmation, not untested code paths:
  a production-sized restore, a physically separate host, and credential-gated
  Anthropic calls. A full mitmproxy TLS-MITM run and a two-host restore drill
  are now covered (see below).
- **0 failed**

### Tests needing real infrastructure (honest assessment)

| Test | What's tested in CI | What needs real infra | Risk | Mitigation |
|---|---|---|---|---|
| 3.1, 3.2, 3.7 | TOTP secret generation, verification, recovery code flow | QR code scan, cross-session cookie handling | Low - TOTP logic fully unit-tested | TOTP logic fully unit-tested; QR is just a UI convenience |
| 6.2, 6.3-6.6, 6.9 | Enrollment token validation, collision detection, token reuse, TLS pinning logic; real enroll/check-in on three OSes | Real mitmproxy for a full TLS-pinning attack | Low - the pin is tested against real TLS handshakes with rogue CAs | `tests/live/agent-smoke.test.ts` runs the real binary on macOS/Linux/Windows; `tls_test.go` covers the pin decision; a mitmproxy reverse-proxy run with a trusted rogue CA was rejected with a pin mismatch (see DR section) |
| 7.1, 7.7-7.10 | Command dispatch, timeout kill, process group kill; real dispatched command | Real process groups, real timeout signals | Low - process group kill tested in CI with real shell | Real command round-trip in `tests/live/agent-smoke.test.ts`; process-group kill tested with real shell in CI |
| 8.1-8.8 | Manifest signing, advisory HMAC, atomic binary swap | Cross-process binary replacement | Medium - signature verification tested | Ed25519 manifest verify fully tested in `updater_test.go` |
| 9.1-9.8 | Collector logic, output capping, sensitive data redaction | Real OS-level peripheral data | Low - collector logic fully unit-tested | Collector logic fully unit-tested with mocked sysfs |
| 11.1, 11.3, 11.8 | Remote session token, guacd protocol, recording; real SSH and RDP sessions | A guacd daemon and target provisioned outside the suite | Low - covered when the external daemon is available | `tests/live/guacd.test.ts` passed SSH 3/3 and RDP 3/3 through the production proxy |
| 12.7 | PDF rendering logic, template sandbox | Chromium binary, fonts, GPU | Low - covered by production suite | `tests/integration/production.test.ts` renders a real PDF with Chromium's sandbox enabled |
| 18.5 | Backup restore logic, encryption handling; cross-key restore | A physically separate machine | Low - the key-rotation failure mode is covered | `tests/live/cross-key-backup.test.ts` restores under different keys; a two-VM drill restored a real backup, failed closed under different keys, recovered under the original keys, then survived destroying the source host and a reboot |

**Optional external confirmation: 1 (full mitmproxy run for §6.9; the pin itself is covered by real-TLS Go tests)**
**Covered by the live suite when its external prerequisite is present: 11.x (guacd), 18.5 (cross-key restore), 22 (SMTP), 28.1 (agent revocation)**
**Partially testable in CI with mocks: 5 (3.x, 6.x, 7.x, 8.x, 9.x)**
**Fully tested in CI or the live suite: §1, §2, §4, §5, §11, §16, §18, §19, §21, §22, §23, §24, §25**

---

## §13-§28 (medium + low priority) — completed

✅ **125 tests pass** across 12 additional files covering:
- §14 Tickets — `vat-and-ticket-rounding.test.ts`, `ws-tickets.test.ts`
- §15 Clients — VAT-ID per-country covered in `vat-and-ticket-rounding.test.ts`
- §17 Templates — `template-renderer.test.ts` (sandbox, allowlist, external image blocking)
- §20 AI brain — `ai-brain.test.ts`, `ai-consultant-mode.test.ts`, `ai-budget-alert.test.ts`, `ai-dispatch-unknown-action.test.ts`, `ai-in-flight-cas.test.ts`, `ai-session-resume-safety.test.ts`, `ai-streaming-redactor.test.ts`, `ai-plan-mode.test.ts`
- §23 Health endpoints — `healthz.test.ts`
- §24 Rate limiting — `rate-limit-windowed.test.ts`
- §25 CSP report endpoint — `csp-report.test.ts`
- §27 Shutdown coordinator — `shutdown.test.ts`

**Coverage by verification status**

| Status | Sections | Count |
|---|---|---|
| ✅ Fully unit-tested + live verified | §1, §2, §4, §5, §11, §16, §18, §19, §21, §22 (SMTP + Telegram), §23, §24, §25 | 13 |
| 🔶 Partially tested (CI + partial live) | §3, §6, §7, §8, §28 | 5 |
| ✅ Fully unit-tested (no live needed) | §9, §13, §14, §15, §17, §20, §27 | 7 |
| ⚠️ Optional external confirmation | §6.9 (full mitmproxy run; the pin itself is covered by real-TLS Go tests) | 1 |

**Total: 53 test-plan items across §1-§28**

---

## Final tally

- **Total automated tests run:** 1,416 hermetic TS tests across 129 files, 40 opt-in live TS tests across 11 files, and all Go packages
- **Pass rate:** 100% of runnable tests, including a real Chromium PDF render in `tests/integration/production.test.ts`
- **Coverage of test-plan items:** critical and RMM sections are fully unit-tested; 13 sections are also live-verified. The external items still open are listed at the end.
- **Bugs found during this verification:** 6 product bugs (3 guacamole-lite integration, 2 Windows agent, 1 RDAP User-Agent) plus 1 CI install issue, all fixed and regression-tested

---

## Live suite expansion (PR #128)

The opt-in suite under `tests/live/` boots the real production artifact and
drives external surfaces. `npm test` stays hermetic; `npm run test:live` runs
this suite.

| Test | Result |
| --- | --- |
| `browser-e2e.test.ts` | Pass: real Chromium setup, login, TOTP enable/login, replay rejection, CSRF rejection, client/invoice creation, real PDF |
| `caddy-tls.test.ts` | Pass: Caddy HTTPS, `Secure` cookie, HSTS, CSRF through the proxy, explicit certificate trust |
| `cross-key-backup.test.ts` | Pass: restore under different `FIELD_ENCRYPTION_KEY`/`SESSION_SECRET`; plaintext survives, encrypted credentials fail closed |
| `agent-smoke.test.ts` | Pass on macOS and Linux locally; pass on Ubuntu and Windows in CI (real enroll, check-in, dispatched command, result). Extended with §28.1: revoke the agent, then prove its next check-in is rejected |
| `smtp-ethereal.test.ts` | Pass: disposable Ethereal account, STARTTLS/AUTH, real send, IMAP verification of CRLF and HTML sanitization, SSRF guard |
| `load.test.ts` | Pass: 6,207 requests / 10 workers, p95 7.8ms, 600/min limiter boundary, health exemption, 20 concurrent writes |
| `receipts.test.ts` | Pass: valid PNG round-trip, GIF-renamed-PNG and SVG rejected, >10 MB rejected, traversal filename ignored, traversal/unauthenticated download rejected |
| `uptime.test.ts` | Pass: HTTP 200/503, loopback/link-local SSRF guard, real TLS certificate expiry, real RDAP domain expiry |
| `guacd.test.ts` | Pass with an externally provisioned daemon: SSH 3/3 and RDP 3/3 through the production WebSocket proxy |
| `telegram.test.ts` | Skips without `TELEGRAM_BOT_TOKEN`/`TELEGRAM_CHAT_ID` |
| `anthropic.test.ts` | Skips without `ANTHROPIC_API_KEY` |

Totals on the local run: **8 files passed / 3 skipped, 34 tests passed / 6
skipped**. The Windows CI job is the first runtime exercise of the Windows
agent and caught both Windows bugs above.

### Bugs found by the live suite

1. guacamole-lite callbacks were passed in `clientOptions` instead of the
   fourth constructor argument, so profile/credentials/session claim never ran.
2. `mergeConnectionOptions()` drops `connection.type`; the protocol check now
   uses `session.protocol`.
3. Replacing the merged connection dropped display defaults, sending guacd a
   `0x0` display.
4. Windows config ACLs were left with an empty DACL (`icacls` ignores
   `(OI)(CI)` on files), denying access to the owner and SYSTEM.
5. Windows inventory check-ins sent `packages:null`/`services:null`, which the
   server schema rejected after the first heartbeat.
6. RDAP domain-expiry monitoring failed every check with HTTP 403 because
   Node's `https.request` sends no `User-Agent` and rdap.org's Cloudflare front
   rejects UA-less requests. The check now sends
   `User-Agent: ITCake-Monitor/1.0`, and `tests/live/uptime.test.ts` performs a
   real lookup so the regression cannot return unnoticed.

---

## Live verification (real running server + agent)

After setting up the server on `http://127.0.0.1:3010` and running the
Go agent against it, the following were verified END-TO-END (not just
by code inspection):

### Setup + auth
- ✅ **§1.1** Empty-DB → `/` redirects to `/setup` (HTTP 302); CSP, HSTS, COOP, Permissions-Policy all in headers
- ✅ **§1.3** Two concurrent register POSTs: ONE wins (201), the other gets 403 "Registration is disabled. A user already exists." Only one user in DB.
- ✅ **§1.4** Setup rate limit: 10 attempts allowed, attempt 11+ returns 429.
- ✅ **§1.5** JSON register without company: 201 with `setupComplete: false` + note.
- ✅ **§2.1** Cookie attrs: `HttpOnly`, `SameSite=Strict`, `Secure`, `Path=/`. Token is 64-lowercase-hex.
- ✅ **§2.2** Cookie with non-hex value: 401 (regex gate).
- ✅ **§2.5** Wrong password vs non-existent email both 401 (timing-equalised).
- ✅ **§2.6** SQL injection in email rejected at validator (email regex).

### CSRF
- ✅ **§4.1, §4.3** POST without Origin → 403.
- ✅ **§4.4** Cross-origin POST → 403.
- ✅ **§4** GET without Origin → 401 (CSRF bypassed for GET, auth fires).
- ✅ **§4** `/api/rmm/*` POST without Origin → 401 (CSRF carved out, bearer fires).
- ✅ **§4** `/api/csp-report` POST → 204 (both CSRF + auth exempt).

### Settings credentials
- ✅ **§5.1** Telegram bot token POSTed plaintext; GET returns `••••••••`; raw token never appears in API response.
- ✅ **§5.2** POSTing the masked value back preserves the prior plaintext (changed chatId, kept token).
- ✅ **§5.4 / §19** Audit-log diff shows `••••••••` for BOTH old + new of the credential — `123456789:abc...` never leaks to `/api/changes`.
- ✅ **DNS-rebinding guard:** SMTP host setting rejected when DNS fails (SSRF defense fires at config-set time).

### Audit log
- ✅ **§19.1** Creating 3 clients writes 3 audit rows; chained HMACs verify.
- ✅ **§19.2** `/api/changes/integrity` returns `anchor: ok`, `tamperedIds: []`, `historyTruncationDetected: false`.

### Agent enrollment
- ✅ **§6.2** Enroll via CLI works; agent gets bearer + manifest pubkey; config saved.
- ✅ **§6.3** Reusing the same enrollment token: "Invalid or already used enrollment token".
- ✅ **§6.5** Same hostname+os+arch collision: "An agent with this hostname/os/arch is already enrolled".
- ✅ **§6.6** Malformed hmacSecret (non-hex): "hmacSecret must be 64-128 hex characters".

### RMM command dispatch (END-TO-END)
- ✅ **§7.1** Dispatched `echo hello-from-live-test; whoami` to a running agent; agent picked it up at next checkin, executed (status=completed, exit=0), stdout returned correctly.
- ✅ **§7.7** Dispatched `sleep 600` with timeoutSeconds=10; status=failed, exit=-1 within ~75s; NO orphan sleep processes (process-group kill confirmed).
- ✅ **§7.6** Cross-agent attack: enrolled an attacker agent; attacker POSTed a fake "completed" result for victim's commandId. Server returned 200 but victim's command STAYED pending — the `WHERE id = ? AND agent_id = ?` predicate silently refused the substitution.

### Health
- ✅ **§23.1** `/api/health` returns `{status:'ok'}`.
- ✅ **§23.2** `/api/healthz` returns full component breakdown: database=ok, disk=ok (89%), puppeteer=connected.

### Rate limiting
- ✅ **§24.1** 650 GETs in <1min: 598 succeed (200), 52 get 429. Cap of 600/min confirmed.

### CSP report
- ✅ **§25.1** Small report POST: 204; log line carries `ip: 'h:<hash>'`, NOT the raw 127.0.0.1.
- ✅ **§25.2** 100KB body: 413.

## Disaster recovery + TLS MITM (two VMs, 29 Oct 2026)

Run on Debian 13 (trixie) ARM64, 2 vCPU / 3 GiB each, under Lima. Node
22.23.4, Caddy 2.6.2, both hosts installed with `install.sh` (Caddy + systemd).

**Host A — production-shaped source host**

- Installed from the release tree, then seeded through the real HTTP API:
  5 clients, 3 invoices, 4 tickets, 1 expense with an uploaded receipt, a
  company logo, and an uptime monitor. MFA enabled with TOTP.
- Upgraded in place to the renamed-template build. Migration 12 remapped
  5 dangling references (3 invoices + 2 settings defaults) and an invoice PDF
  still rendered: HTTP 200, 38,053 bytes, `%PDF-` magic.
- Backup created and downloaded: `backup-2026-10-29-201305.zip`, 25,947 bytes,
  containing `itcake.db`, `manifest.json`, `uploads/logo.png`, and
  `uploads/receipts/<id>.png`.

**Host B — recovery host**

- Fresh install with a different `FIELD_ENCRYPTION_KEY` and `SESSION_SECRET`
  (verified different), own Caddy and systemd unit.
- First-run setup, then restore through `POST /api/backups`
  (`action: restore`): HTTP 200 `{ok:true}`.
- Plaintext business data survived: 5 clients, 3 invoices, 4 tickets,
  1 expense; invoice `templateId` already `itcake`.
- Encrypted credentials failed closed: login asked for MFA, the correct TOTP
  code for host A was rejected with 401, and the service log recorded
  `v3 decryption FAILED`. Health stayed 200.
- Original keys restored → full recovery: TOTP login 200, 5 clients and
  3 invoices through the API, invoice PDF 200 / 38,053 bytes / `%PDF-`.

**Host A destroyed, host B proven independent**

- `limactl delete itcake-dr-a`; host B continued to serve with no reference
  to A.
- Rebooted host B: `itcake` and `caddy` both auto-started, and the full check
  (health, TOTP login, data, PDF) passed again.

**TLS MITM against the pinned agent**

- mitmproxy 12.3.1 in reverse mode on `127.0.0.1:8443`, forwarding to the real
  server; its CA was installed in the host trust store, modelling an attacker
  who holds a trusted certificate.
- Control: `curl` through the proxy returned `200` with the real health JSON,
  proving the traffic was actually intercepted.
- The agent was enrolled against the real server with `--pin-tls`. Pointed at
  the proxy, every check-in failed with
  `TLS pin mismatch — leaf SPKI does not match pinned value 5eec550926669862…`.
- Server-side proof: the agent row kept `last_seen_at = null`, so no check-in
  succeeded through the MITM.

**Honest limits of this drill**

- Both hosts ran on the same hypervisor and host disk; this is not a
  physically separate machine, a network partition, or a power-loss test.
- The backup was 25 KB, so restore timing is not representative of a
  production-sized database.
- The MITM was performed on the same VM as the server; the pin decision and
  the certificate trust model are exercised, but not a real network attacker.

## Soak and automated scans (VM, 29 Oct 2026)

Same Debian 13 ARM64 VM, app behind Caddy with systemd, one admin with MFA.

**Soak (15 min, 8 workers, ~6 req/s)**

- 5,580 requests: 5,536 × 200 and 44 × 201 (ticket writes), **0 errors and
  0 rate-limited** responses.
- Latency: p50 9.96 ms, p95 41.2 ms, p99 226.7 ms, max 2.15 s. The tail is a
  single outlier, not a sustained trend.
- Process: RSS 144.7 MB → 147.8 MB (peak 147.8), open FDs 35 → 34 (peak 37),
  threads constant at 11. No growth trend over the window.
- Database: 540,672 → 565,248 bytes (44 new tickets). SQLite WAL stayed bounded.
- An earlier 30-minute run was discarded: the harness never called its login
  helper, so every authenticated request returned 401 and only `/api/healthz`
  succeeded. Those numbers are not reported as results.

**Automated scans**

- `nmap`: public listeners are 22, 80 and 443. The app (3000) and the Caddy
  admin API (2019) listen on loopback only.
- `testssl.sh` 3.2.4: SSLv2/SSLv3 not offered, TLS 1.0/1.1 not offered,
  TLS 1.2 and 1.3 offered, forward secrecy with AEAD, not vulnerable to
  Heartbleed, CCS or ROBOT. The certificate is the local Caddy CA and
  short-lived, as expected in the lab.
- `nuclei` 3.11.1: 6,514 HTTP templates, 15,895 requests, **0 matches** at
  medium/high/critical; 38 template timeouts.
- `npm audit`: 4 low-severity advisories (the known `@sveltejs/kit` /
  `deepmerge` build-time chain), 0 moderate, 0 high, 0 critical.

**Observations, not failures**

- Caddy's admin API listens on `127.0.0.1:2019` by default. It is loopback-only,
  but any local account could reconfigure the proxy. On a multi-user host,
  restrict it (`admin off` or a unix socket) or firewall the loopback.
- Puppeteer's Chromium exposes a loopback DevTools port while running. That is
  inherent to headless Chrome; the process runs as the app user.
- The base cloud image also runs `containerd` on loopback; it is not part of
  ITCake and does not exist on a normal minimal install.

None of this is an external penetration test.

## Final code-quality pass (macOS, 29 Oct 2026)

Run on the development host (macOS, Node 26.13.0, Chrome for Testing
156.0.8078.47), after the VM work.

**Coverage (hermetic suite, `vitest --coverage`)**

- Lines 64.48% (5,055/7,839), statements 61.21%, functions 61.36%,
  branches 49.89%.
- 36 of 144 files are under 50% line coverage. The largest gaps are
  `checks/http.ts`, `checks/ping.ts`, `checks/ssl.ts`, `checks/rdap.ts`,
  `monitor-checks.ts`, `alerts.ts`, `pdf.ts` and `template-context.ts` — all
  exercised by the opt-in live suite or only against real network targets, not
  by the hermetic run. The percentage is therefore a floor, not a ceiling, but
  it is a measured number rather than an assumption.

**Dead-code analysis (`knip` 6.44)**

- No unused production modules. The four "unused files" are false positives:
  template CSS is loaded by path at runtime, `scripts/rotate-session-secret.mjs`
  is documented in the runbook, and `src/env.ts` is the SvelteKit env schema.
- Removed three genuinely unused icon re-exports and unexported four symbols
  that were only used inside their own module.
- Declared `tailwindcss` as a devDependency; it is imported by `app.css` but was
  only available transitively.
- Remaining reports are type-only exports and test helpers.

**Bug found by running on macOS**

- `install.sh` used `${VAR,,}` (bash 4+) in four prompts. macOS ships bash 3.2,
  so the installer aborted with `bad substitution`; CI runs Ubuntu and never
  saw it. Replaced with a `tr`-based `lower()` helper. The installer test now
  passes under `/bin/bash` 3.2.

**macOS live suite**

- `npm run test:live`: **29 passed, 11 skipped, 0 failed** across 6 files.
  Covered: real Chromium setup/login/TOTP/client/invoice/PDF, cross-key
  restore, load, receipt uploads, uptime HTTP/TLS/RDAP probes, SMTP Ethereal.
- Skips: Caddy (not installed on the host), Go agent (no Go toolchain),
  Telegram/Anthropic (no credentials), guacd (no daemon).

---

## Live tally

**Tests run end-to-end with real server + real agent:** ~30 in the original
container-era pass; the suite has since been rewritten to run directly on a
host or VM. The Linux ARM run passed 37 and skipped 3; the current macOS run
passed 29 and skipped 11 (Caddy, Go, guacd and the two credential-gated tests
are unavailable there). Telegram was verified separately with a disposable bot,
so Anthropic is the only credential-gated test that has never been run.

**All passed.** Including the most-critical cross-agent attack defense
(§7.6) and the actual subprocess process-group kill on command timeout
(§7.7) — both proven against a live attack scenario.

**Combined with static + automated coverage:**
- Critical sections (§1-5, §7, §11, §12, §18, §19, §26): code+test verified; live-verified where external infrastructure is available.
- RMM sections (§6, §7, §8, §9, §10): code+test+Go-tests verified; §6 and §7 also live-tested end-to-end on macOS/Linux/Windows.
- Medium sections (§13-§28): unit and integration tests pass; SMTP, PDF, receipt
  uploads, uptime HTTP/TLS/RDAP probes, and agent revocation are live-verified.

**Still genuinely needing external setup:**
- Anthropic live calls — tests are written and skip until a disposable API key is provided. Telegram is now live-verified.
- A physically separate restore host, network partition, or power-loss drill.
  The two-VM drill above proves the software restore path, systemd/Caddy
  auto-start, and cross-key behaviour; it does not prove hardware or network
  failure handling.
- An independent external penetration test. Automated scans are a pre-test
  pass, not a substitute for one.
- A production-sized backup restore. The drill used a 25 KB backup, so restore
  duration and memory use under a large database are still unmeasured.
