# ITCake

Single-user self-hosted web app: invoicing, tickets/time-tracking, uptime monitoring, RMM (Go agent), remote desktop (Apache Guacamole).

## Stack

SvelteKit (Svelte 5) + adapter-node, TypeScript, `better-sqlite3` (WAL), Tailwind v4, Vite 7, Node ≥ 20. Zod, bcryptjs + HMAC-SHA256 sessions, Nodemailer, Puppeteer, EJS, sanitize-html, dayjs, lean-qr, JSZip, guacamole-lite. Go agent in `agent/` (own `go.mod`, `CGO_ENABLED=0`, `-trimpath -buildvcs=false -ldflags='-s -w'`).

## Architecture invariants — align rather than replace

These are intentional for a single-user self-hosted app. Don't suggest swapping them for "industry-standard" alternatives (ORM, session library, Postgres) — at this scale they add complexity, dependencies, and attack surface for zero gain. Do still flag genuine bugs or security flaws in the existing pattern.

- Raw prepared SQL against JSON-in-SQLite document store. No ORM.
- Custom HMAC-SHA256 session tokens, not a session library. **Single active session per user** (`createSessionTx` deletes all before inserting).
- Money: integer cents everywhere. Never float. `computeInvoiceTotals` absorbs discount-rounding remainder into the largest tax group.
- Uptime + RMM use dedicated tables (not the document store) — time-series needs range queries.
- Two auth groups: bearer-only on `/api/rmm/*` (CSRF-exempt, JSON errors), cookie session on `/api/agents/*` and `/api/*` (CSRF-enforced). `/api/auth/*` pre-auth, `/api/config` GET only.
- **Every new feature or behavior change ships with a test** in `tests/integration/lifecycle.test.ts` or `tests/unit/`. No exceptions.
- **Comments are off by default — bare-minimum critical only.** Write one only if its absence would let a future change cause a real bug: a workaround for a known external library bug (cite version), a TS quirk that's fixable but obscure, a hidden constraint the type system genuinely can't express. NOT for "explaining the design", NOT for security rationale that's obvious from the code itself, NOT for "because X" prose. If you can read the code and answer "why" — no comment. Function names + parameter types are the documentation. No section banners, no "Get/Set/Build X" labels, no "what" comments, no design narration.

## Document store + mutation routing + i18n

`documents(id, type, data JSON, created_at, updated_at)`. Helpers in `db.ts`: `getDocument`, `getDocumentsByType` (10k cap), `insertDocument`, `updateDocument`, `deleteDocument`. Filter on `type` + `json_extract(data, '$.field')` with expression indexes.

Two mutation paths — don't mix:
- **API routes** (`/api/*`) — `POST` with `action: 'update'|'delete'` (default = create). Used by `fetch()`. Pattern: `POST /api/{entity}` with `{ action, id?, ...data }`.
- **Form actions** (`?/name` on page servers) — status changes, credit notes, duplicate, convert-to-invoice. Used by `<form>`. Live in `routes/(app)/invoices/[id]/+page.server.ts` and `proposals/[id]/+page.server.ts`.

i18n — three systems, never hardcode user-facing strings:

| System | Files | Function |
| --- | --- | --- |
| UI | `src/lib/i18n/{en,de}.ts` | `t('key')` reactive store |
| Server errors | `src/lib/i18n/server.ts` | `serverT(lang)('key', { params })` |
| PDF templates | `assets/templateStrings/{en,de}.json` | `t('key')` in EJS |

Server errors → `throw new ServiceError('error.key')` (translated at API boundary via `translateServiceError`).

## Allowlists — update them all when adding a key/type/table

| Adding | Update |
| --- | --- |
| **Settings key** | `db.ts` `defaultSettings` + `services/settings.ts` `VALID_SETTINGS_KEYS` + `services/backups.ts` `VALID_SETTINGS_KEYS` + section schema in `routes/api/settings/+server.ts` |
| **Document type** | `documents` table CHECK constraint + `backups.ts::VALID_TYPES` |
| **Audit log entity/action** | `lib/server/changes.ts` `ChangeEntityType`/`ChangeAction` + `backups.ts::VALID_ENTITY_TYPES`/`VALID_ACTIONS` + (if mapping needs an HTTP status) `request-utils.ts` `SERVICE_ERROR_STATUS` |
| **RMM table** | `replaceTables` in `restoreBackup()` |
| **Agent command type** | `validators-rmm.ts` `commandTypeEnum` + `db.ts` `agent_commands` CHECK rebuild + `agent_schedules` CHECK rebuild + Go agent `checkin.go` switch |
| **Numbered entity** | seed counter in `db.ts` (keys: `invoice_global`, `proposal_global`, `client_global`, `ticket_global`, `agent_global`) |

Settings deep-merge protected against prototype pollution (`__proto__`, `constructor`, `prototype`, `__defineGetter__`, etc.).

## DB tables

`users` (totp_secret/totp_enabled/totp_recovery_hashes), `sessions`, `mfa_used_challenges` (nonce → expires_at; single-use guard for MFA challenges), `documents`, `settings`, `changes` (audit + chained hash), `counters`, `rate_limits`, `monitors`, `monitor_checks` (48h), `monitor_daily` (forever), `agents` (last_auto_update_at, tags, hmac_secret encrypted), `agent_enrollment_tokens`, `agent_metrics` (48h), `agent_commands`, `agent_services`, `agent_packages`, `agent_schedules`, `agent_events`, `alert_rules`, `remote_sessions`.

## Environment variables

| Variable | Default | Purpose |
| --- | --- | --- |
| `DATABASE_PATH` | `data/itcake.db` | SQLite path |
| `DATA_DIR` | `data` | Uploads, backups, agent-binaries, recordings |
| `HOST` / `PORT` | `127.0.0.1` / `3000` | Bind |
| `ORIGIN` | — | Required in prod for CSRF |
| `NODE_ENV` | — | `production` enforces secure cookies + `SESSION_SECRET` |
| `SESSION_SECRET` | — | HMAC for sessions/at-rest enc; ≥32 chars in prod |
| `PUPPETEER_NO_SANDBOX` | `false` | `true` for Docker/root |
| `ADDRESS_HEADER` | — | Real IP behind proxy |

SMTP, Telegram, off-site backup, Guacamole all configured in-app, not via env.

## Commands

```sh
npm run dev | build | start | check | test
npm run build:agent | build:agent:all
```

## Conventions

- All DB mutations in `db.transaction()`. Audit log via `recordChange()`.
- Status transitions: `validateTransition<S>(map, current, target, label)` in `document-helpers.ts`.
- API routes: `parseJsonBody()` (1 MiB cap) + Zod. LIKE search escapes `%`, `_`, `\` with `ESCAPE '\'`. Update endpoints that take a `<Schema>.partial()` MUST go through `parseUpdateBody(schema, input)` (or its primitive `pickPresentKeys(parsed.data, input)`) in `request-utils.ts` — Zod 4's `partial()` keeps `.default()` values, so a PATCH of `{notes:'x'}` would otherwise overwrite every other field with its schema default. The action-router routes (`/api/{units,catalog-items,clients,monitors,tickets,invoices,proposals}`) dispatch via `handleActionPost(request, locals, { create, actions })` which centralises auth, JSON parsing, the action allowlist, and `ServiceError → HTTP` translation.
- CSRF: Origin/Referer in `hooks.server.ts` for state-changing requests. RMM agent endpoints exempt (bearer auth) and return `json({error}, {status})` — never `throw error()` (agents parse JSON, not HTML).
- File uploads: magic-byte verification, path-traversal guards, extension allowlists.
- EJS: built-in trusted; custom sandboxed (allowlist + prototype-free + deep-frozen + JS disabled in Puppeteer); option keys `/^[a-zA-Z][a-zA-Z0-9_]*$/`.
- PDF: Puppeteer with JS **disabled** + request interception blocking non-`data:` URLs. Logos converted to `data:` in template-context. Concurrency: 4-page semaphore + browser-launch mutex.
- DNS-pinned SSRF protection via `resolveAndValidate()` — covers IPv4 private/reserved, IPv6 loopback/link-local/ULA/mapped/NAT64/6to4/Teredo. Used by ping/HTTP/SSL/RDAP (each redirect re-validated; max 5 hops).
- Session tokens: `crypto.timingSafeEqual` over all active sessions.
- Notification error persistence: Telegram/email failures write `uptime.lastNotifyError`; cleared on next success.
- Backup restore: explicit column mapping via `PRAGMA table_info`; rejects DBs with triggers/views; ticket descriptions re-sanitized.
- Validators in `src/lib/validators-rmm.ts` for all RMM endpoints (incl. tags, alert rules, bulk dispatch). Enrollment rate-limited 10/IP/15 min.
- `processCommandResult(commandId, agentId, ...)` requires `agentId` — prevents cross-agent spoofing.

## Encryption — what's encrypted where

| Surface | Mechanism | Notes |
| --- | --- | --- |
| Bearer/session tokens, TOTP recovery codes | HMAC-SHA256 hash | irreversible by design |
| SMTP pass, Telegram bot token, TOTP secret, **backup passphrase**, **S3/WebDAV creds** | AES-256-GCM via `field-crypto.ts` (`enc:` v1, `enc2:` v2 — HKDF + per-blob salt) | keyed by `SESSION_SECRET` (scrypt-derived master key). v1 decrypts on read, re-writes as v2. No-op without `SESSION_SECRET` |
| **agent HMAC secret**, **per-agent remote-desktop password / private-key** | AES-256-GCM via `field-crypto.ts` (`enc3:` v3 — AAD `agent.hmacSecret:<id>` / `agent.remoteDesktop.password:<id>` / `agent.remoteDesktop.privateKey:<id>`) | row-bound: a DB writer who copies one agent's ciphertext into another agent's row sees GCM tag verification fail. v2 ciphertexts auto-migrate to v3 on next write |
| Backup ZIP (optional) | AES-256-GCM via `backup-crypto.ts` (scrypt N=2^15 from passphrase) | `.zip.enc` form. Independent of `SESSION_SECRET` — protects the artifact off-box |
| Audit log integrity | HMAC-SHA256 chain (`changes.hash`) keyed by `SESSION_SECRET` | `verifyAuditLogIntegrity()` + `GET /api/changes/integrity`. Rows immutable |
| Agent config on disk | AES-GCM keyed by machine-id | defense-in-depth, NOT a boundary against local root |
| Binary integrity | `X-Binary-SHA256` + RFC 9530 `Content-Digest` header | agent cross-checks |

## Response headers

HSTS includes `preload` in prod. API JSON: `Cache-Control: no-store`. Plus `Cross-Origin-Resource-Policy: same-origin`, `X-DNS-Prefetch-Control: off`, expanded `Permissions-Policy`. CSP via SvelteKit nonce-based config (svelte.config.js) + `/api/*` fallback in `hooks.server.ts` — explicit `worker-src 'none'`, `manifest-src 'self'`, `media-src 'none'`, `frame-src 'self'`, `child-src 'self'`.

## RMM

### Agent security model

Privileged service: LaunchDaemon / systemd / SCM (LocalSystem / root).

**Enrollment:** operator generates 15-min single-use token → agent generates 32-byte hex `hmacSecret` via `crypto/rand` → posts `{token, hostname, os, arch, hmacSecret}`. Server stores `hmacSecret` AES-GCM-encrypted under `SESSION_SECRET` (was plaintext; migrated on startup) and bearer token as HMAC-SHA256 hash. Config AES-GCM-encrypted with machine-id-derived key (Linux `/etc/machine-id`, macOS IOPlatformUUID, Windows MachineGuid). Optional `--pin-tls` captures leaf SPKI (survives renewal, breaks on key rotation); `--insecure` is enrollment-only, never persisted.

**Command dispatch:** `{ id, agentId, type, payload, payloadRaw, signature, issuedAt, timeoutSeconds }`. Signature = HMAC over `id:agentId:type:payloadRaw:issuedAt`. Agent verifies: agentId match, signature, ±10 min replay window, replay cache. `payloadRaw` is verbatim DB bytes — re-serializing breaks byte-stability.

**Privilege:** on macOS, `Execute()` drops the running command to the console user via `sudo -u` so brew/npm/pip can find that user's profile; on Linux, `Execute()` runs as the service identity (root under systemd) and only the `packages.ConsoleUser` helper consults `$SUDO_USER` for brew/npm/pip command-string construction. `ExecuteAsRoot()` for `/Applications` removal / OS updates / reboot. Windows: `cmd.exe /d /s /c` + `CREATE_NO_WINDOW`, already root, no scoop in SYSTEM context (refuses). PowerShell isn't a separate code path — `cmd /c` dispatches to `powershell.exe` when the operator-supplied command starts with `powershell`.

**Self-update:** server sends `binaryHash` (SHA-256) on every checkin; agent downloads over pinned TLS, verifies hash, runs the new binary's `version` subcommand as a smoke test, atomic rename, exits for service manager to restart. `last_auto_update_at` is a dedicated column (separate from `updated_at` which bumps every check-in).

**AV-friendliness:** no UPX/packers (90% trigger heuristics); `-trimpath -buildvcs=false`; Windows VERSIONINFO + manifest via `go generate ./cmd/agent`; metrics via Win32 APIs only at runtime (no WMI/PowerShell).

**Transport caps:** TLS 1.2+ enforced client-side; response 1 MiB; error 4 KiB; jitter ±10%; checkin payload caps stdout 1 MiB / stderr 256 KiB / packages 10k / services 1k.

**Files:**

| OS | Binary | Config (AES-GCM) | Service | Log |
| --- | --- | --- | --- | --- |
| macOS | `/usr/local/bin/itcake-agent` | `/Library/Application Support/ITCake/agent-config.json` 0600 | `/Library/LaunchDaemons/com.itcake.agent.plist` | `/var/log/itcake-agent.log` |
| Linux | `/usr/local/bin/itcake-agent` | `/etc/itcake-agent/config.json` 0600 | `/etc/systemd/system/itcake-agent.service` | journald |
| Windows | `C:\ProgramData\ITCake\itcake-agent.exe` | `C:\ProgramData\ITCake\agent-config.json` | SCM `ITCakeAgent` (auto + recovery 5s/30s/2m) | Event Log + stdout to SCM |

### Settings (in `validators-rmm.ts`)

| Setting | Default | Range |
| --- | --- | --- |
| `defaultCheckinInterval` | 60 s | 10–3600 |
| `staleThresholdMinutes` | 5 | 1–60 |
| `metricsRetentionHours` | 48 | 1–720 |
| `commandTimeoutSeconds` | 300 | 5–3600 |

Status: `online` → `stale` (2× threshold) → `offline` (3× threshold).

### Features

- **Scheduled scripts** — `agent_schedules` rows with 5-field cron (`*`, `N`, `N-M`, `N,M`, `*/N`). Parser in `lib/server/cron.ts`. 60 s tick → `processDueSchedules()` → `dispatchCommand()` (same HMAC pipeline). `next_run_at` precomputed, rolled forward after each fire. **Cron expressions are evaluated in UTC, not the operator's local timezone** — the UI labels the input accordingly. UTC sidesteps DST skip/double-fire bugs for free.
- **Event log collection** — agent reads level≥warning entries (journalctl / `log show` / wevtutil) once per 10 check-ins (rides inventory cycle so it doesn't fork a child every minute). Stored in `agent_events`, pruned on `metricsRetentionHours` cadence.
- **Software inventory delta** — `upsertPackages` diffs each per-manager snapshot vs prior, emits `agent_events` (level=warning, source=`package_change:<manager>`) for installs/removes/upgrades. First snapshot per manager suppressed when it consists entirely of installs above 5 (otherwise every package looks "newly installed").
- **Alert rules** — `alert_rules` table; evaluated every 60 s in `evaluateAlertRules()`. `condition` is JSON discriminated by `kind`: `metric_threshold` (cpu/memory/disk avg over duration), `agent_offline`, `agent_reboot_required`, `monitor_status`. Per-rule cooldown via `last_fired_at`. Notifications reuse uptime-settings Telegram + email channels. `tagAny` filter on agent-scoped conditions.
- **Tags + bulk dispatch** — `agents.tags` JSON array (lowercase, `[a-z0-9_-]`, ≤50 chars, ≤30 tags). `getAgentsByTags({any?, all?})` resolves a filter. `POST /api/agents/dispatch` (`bulkDispatchSchema`) signs + queues a separate command per matched agent — each carries its own HMAC.
- **Reboot** — command type `reboot` with payload `{ delaySeconds?: 0..86400, message?: string }`. Agent: `shutdown -r +<min>` on Unix, `shutdown.exe /r /t <sec> /f` on Windows, via `ExecuteAsRoot`. Default 60 s delay so agent can ack before OS reboot.

## MFA / TOTP

Two-step login. POST 1 = email+password → if MFA on, returns `{ mfaRequired, mfaToken }` (5-min HMAC over `userId.expiresAt.nonce`, single-use server-tracked via `mfa_used_challenges`). POST 2 = email+password+token+TOTP/recovery code. TOTP secret AES-GCM at rest; recovery codes HMAC-SHA256 hashed (keyed by `SESSION_SECRET`), consumed atomically via optimistic-CAS update on `users.totp_recovery_hashes`. Disable requires password + TOTP/recovery. **Password change** also requires TOTP/recovery code when MFA is enabled — without it, a stolen-cookie attacker who shoulder-surfed the password could rotate it without the second factor. Both enable and disable revoke all of the user's active sessions inside the same DB transaction. `signMfaChallenge`/`verifyMfaChallenge`/`consumeMfaChallenge` in `lib/server/totp.ts`.

## Backup

**Local + downloads** — ZIP via `services/backups.ts`. Restore validates allowlists (see allowlist table above); explicit column mapping when schemas differ.

**Optional encryption** — `settings.backup.encryptionPassphrase` wraps the ZIP with AES-256-GCM (scrypt-derived key). Saved as `.zip.enc`. Restore detects + decrypts. Independent of `SESSION_SECRET`.

**Off-site upload** (admin-configurable) — `settings.backup.offsite`. Targets: **S3-compatible** (manual SigV4, no aws-sdk dep) or **WebDAV** (Nextcloud / Hetzner / mod_dav). Schedule = `daily | weekly | manual`. 24 h tick checks `lastUpload.at` against cadence. Credentials encrypted; `***` masked in API responses; submitting `***` preserves prior. `POST /api/backups/offsite` `{ test: true }` or `{ run: true }`. Service in `services/backup-offsite.ts`.

## Remote desktop (Apache Guacamole, baked in)

ITCake spawns and supervises **guacd** (the C daemon — install via OS package manager from the admin UI; updates via the same path) and proxies WebSocket → guacd via **guacamole-lite**. The browser embeds **guacamole-common-js**.

**Connection lifecycle:**
1. Operator clicks "Remote desktop" on agent detail → `POST /api/agents/{id}/remote-session` returns a one-time HMAC-signed **session token** (5-min TTL, hash stored in `remote_sessions` — distinct from the support-ticket entity).
2. Browser opens a popup at `/remote-desktop/{token}` which loads guacamole-common-js and connects WebSocket `/api/remote-desktop/ws?token=<token>` (single-use).
3. guacamole-lite validates the token, opens TCP to `guacd` (127.0.0.1:4822 by default), forwards the Guacamole protocol.
4. On disconnect, `remote_sessions.ended_at` is set (via `markRemoteSessionEnded`); recording (if enabled) is finalized.

**Hardening:**
- guacd binds 127.0.0.1 only — no external surface. ITCake supervises lifecycle via `services/guacamole.ts`.
- Session tokens are short-lived (5 min), single-use, consumed on first WebSocket upgrade.
- Per-agent connection profile (`agents.data.remoteDesktop`: protocol, port, username, password (field-encrypted), ignoreCert, domain) — only the operator's authenticated session can request a session token.
- **Encrypted Guacamole token carries no credentials.** It contains only `{ connection: { type }, itcakeSessionId }`. Hostname/port/username/password/recording-path are resolved server-side via guacamole-lite's `processConnectionSettings` callback at WS-open time, keyed on the already-validated `itcakeSessionId`. Bit-flipping the AES-256-CBC ciphertext can therefore at worst produce JSON-parse failure or a sessionId-mismatch — never a credential leak or host redirection. The callback also enforces a protocol match between the token's declared `connection.type` and the agent profile's actual protocol.
- Audit log via the existing `changes` chain: entity type `remote_session`, actions `create` (token issued), `connect` (WebSocket open), `disconnect` (WebSocket close).
- Optional session **recording** — guacd writes `.guac` files to `DATA_DIR/recordings/<session-id>/`. Playback via `GET /api/remote-desktop/recording/<sessionId>`: lazily transcodes to MP4 with `guacenc` on first access, unlinks the source `.guac` on success, and serves the MP4 as `attachment` so the browser saves it for OS-side playback (avoids the `/api/*` strict CSP). Owner-only (the operator who opened the session).
- WebSocket Origin validated on upgrade — same protection as REST CSRF.

**Install/update from the official source** — `POST /api/remote-desktop/guacd` `{ action: 'install'|'update'|'status' }`. Linux: apt/dnf/pacman/apk; macOS: brew. Windows is unsupported by upstream — admin UI surfaces this. Detection: `which guacd` + `guacd -v`. Updates run the same package-manager upgrade command.

## Operator runbook

| Task | Steps |
| --- | --- |
| **Revoke a compromised agent** | `POST /api/agents` `{ action: 'delete', id }`. Invalidates bearer + HMAC instantly. Audit-logged. |
| **Rotate a compromised SESSION_SECRET** | Stop service → set new value → start. Loses: audit-log hash chain (becomes "unverified"), all sessions, all field-encrypted values, TOTP recovery hashes. After restart: re-enter SMTP + Telegram, re-pair MFA + regenerate recovery codes, re-enroll all agents, re-enter backup credentials, re-enter per-agent remote-desktop passwords. Plan a maintenance window. |
| **Restore from backup** | UI → Backups → Restore. If `.zip.enc` form, the configured passphrase must still match. Backup contains current SESSION_SECRET-derived ciphertexts — restore on a different host without the same SESSION_SECRET makes encrypted fields unrecoverable. |
| **Enable off-site backup** | Settings → Backup → enable, choose S3 or WebDAV, fill creds, "Test connection", set schedule. Secrets stored encrypted; UI shows only `***` afterwards. |
| **Set a backup passphrase** | Settings → Backup → enter passphrase. New ZIPs become `.zip.enc`. Old `.zip` backups remain readable. Changing the passphrase locks out previously-encrypted backups — keep the old passphrase until those are rotated out. |
| **Install/update Guacamole** | Settings → Remote Desktop → "Install guacd" / "Update". Runs OS package manager. After install, supervisor binds 127.0.0.1:4822. The `/api/remote-desktop/guacd` `{ action: 'status' }` endpoint reports current state on demand; there is no automatic background health-check tick. |
| **Audit-log integrity check** | `GET /api/changes/integrity` returns any tampered row IDs. Pre-migration rows show as `unverified` (legacy, expected). Anything labeled `tampered` is a real incident. |
| **External monitoring** | ITCake monitors others; have something else monitor ITCake. Point pingdom / uptimerobot / ohdear at `/api/health`. |

## Background tasks (`hooks.server.ts`, all `setInterval(...).unref()`)

- 60 s — uptime checks · RMM stale detection · command expiry · cron-schedule dispatch · alert evaluation · expired remote-desktop session-token cleanup
- 60 min — session cleanup · recurring invoices · overdue marking
- 1 h — RMM auto-update tick (per-agent interval)
- 24 h — prune audit log >1y · uptime daily aggregation/prune · RMM metrics prune · agent-events prune · off-site backup tick

Overlap guards on `runChecks`/`runDailyChecks`.

## Security model invariants

Cross-cutting boundaries enforced across multiple files. Treat changes here as a security review, not a refactor — each line below is load-bearing and not derivable from any single inline comment.

- **Agent HMAC secret per-device, AES-GCM-encrypted at rest, logically verbatim** — derived neither from `SESSION_SECRET` nor hashed (HMAC needs the key recoverable). Stored as `enc3:` (v3) ciphertext with AAD `agent.hmacSecret:<agentId>` so a DB writer who copies one agent's encrypted secret into another agent's row sees GCM tag verification fail at the destination. Agent compromise still can't forge cross-agent commands. Legacy pre-migration agents (empty `hmac_secret`) cannot have commands dispatched to them: `signCommand` throws `LegacyEnrollmentError` so the operator sees the diagnosis up front. Re-enroll the agent to issue commands again.
- **Command `payloadRaw` verbatim on the wire** — `getPendingCommandsRaw()` preserves exact DB bytes; the agent recomputes HMAC over those bytes. Re-marshalling on either side breaks signature verification.
- **`--insecure` is enrollment-only and never persisted** — combine with `--pin-tls` to capture-then-enforce a self-signed cert. After enroll, TLS verification is unconditional; there's no on-disk flag that can re-enable it.
- **Machine-bound config encryption is defense-in-depth, NOT a boundary against local root** — an attacker with local root can re-derive the key. The encryption protects against casual exfiltration via whole-disk backups, not active compromise.
- **Encrypted Guacamole token carries no credentials** — see Remote-desktop section. Sensitive connection details (hostname, password, recording-path) resolve server-side via the `processConnectionSettings` callback at WS-open time, keyed on the already-validated `itcakeSessionId`. The per-agent password / private-key in `agents.data.remoteDesktop` are AAD-bound (`enc3:` with `agent.remoteDesktop.password:<id>` / `agent.remoteDesktop.privateKey:<id>`) so a DB-write attacker without `SESSION_SECRET` cannot redirect agent A's password to agent B by row-shuffling the ciphertext.
- **Remote-desktop "session tokens" are bearer credentials, stored only as HMAC-SHA256 hashes** — raw value never persisted. Naming note: distinct from the support-ticket entity (`documents.type='ticket'`); these are short-lived single-use credentials for opening a Guacamole connection.
- **Password change requires the second factor when MFA is enabled** — `POST /api/auth/password` rejects with 403 when `users.totp_enabled = 1` and no `mfaCode` is supplied. Without this gate, a stolen-cookie attacker who shoulder-surfed the password could rotate it (and lock the legitimate operator out) without ever proving possession of the TOTP / recovery code.

## Upstream advisories (informational only)

- `yauzl <3.2.1` (GHSA-gmq8-994r-jv83) via `puppeteer` — not used for user ZIPs.

The `cookie <0.7.0` advisory (GHSA-pxg6-pf52-xh8x) is forced to ^0.7.2 via `package.json#overrides` until SvelteKit's transitive bumps catch up.
