# ITCake

Single-user self-hosted web app: invoicing, tickets/time-tracking, uptime monitoring, RMM (Go agent).

## Stack

SvelteKit (Svelte 5) + adapter-node, TypeScript, `better-sqlite3` (WAL), Tailwind v4, Vite 7, Node ≥ 20. Zod, bcryptjs + HMAC-SHA256 sessions, Nodemailer, Puppeteer, EJS, sanitize-html, dayjs, lean-qr, JSZip. Go agent in `agent/` (own `go.mod`, `CGO_ENABLED=0`, `-trimpath -buildvcs=false -ldflags='-s -w'`).

## Architecture — deliberate choices, align rather than replace

These are intentional for a single-user self-hosted app. Don't suggest swapping them for "industry-standard" alternatives (ORM, session library, Postgres) — at this scale they add complexity, dependencies, and attack surface for zero gain. Do still flag genuine bugs or security flaws in the existing pattern.

- Raw prepared SQL against JSON-in-SQLite document store. No ORM.
- Custom HMAC-SHA256 session tokens, not a session library.
- Single-user app. One active session per user (`createSessionTx` deletes all before inserting).
- **Every new feature or behavioral change ships with a test** in `tests/integration/lifecycle.test.ts` or `tests/unit/`. No exceptions.
- Uptime + RMM use dedicated tables — time-series needs range queries.
- Money: integer cents everywhere. Never float. `computeInvoiceTotals` absorbs discount-rounding remainder into the largest tax group.
- Agent auth = bearer token only on `/api/rmm/*` (CSRF-exempt, JSON errors). UI auth = cookie session on `/api/agents/*` (CSRF-enforced).

## Document store

`documents(id, type, data JSON, created_at, updated_at)`. Helpers in `db.ts`: `getDocument`, `getDocumentsByType` (10k cap), `insertDocument`, `updateDocument`, `deleteDocument`. Filter on `type` + `json_extract(data, '$.field')` with expression indexes.

## Mutation routing — two paths, don't mix

- **API routes** (`/api/*`) — CRUD via `POST` with `action: 'update'|'delete'` (default = create). Used by `fetch()`. Pattern: `POST /api/{entity}` with `{ action, id?, ...data }`.
- **Form actions** (`?/name` on page servers) — status changes, credit notes, duplicate, convert-to-invoice. Used by `<form>`. Live in `routes/(app)/invoices/[id]/+page.server.ts` and `proposals/[id]/+page.server.ts`.

## i18n — three systems, never hardcode user-facing strings

| System | Files | Function |
| --- | --- | --- |
| UI | `src/lib/i18n/{en,de}.ts` | `t('key')` reactive store |
| Server errors | `src/lib/i18n/server.ts` | `serverT(lang)('key', { params })` |
| PDF templates | `assets/templateStrings/{en,de}.json` | `t('key')` in EJS |

Server errors → `throw new ServiceError('error.key')` (translated at API boundary via `translateServiceError`).

## Settings — update ALL THREE on new key

1. `db.ts` `defaultSettings`
2. `services/settings.ts` `VALID_SETTINGS_KEYS`
3. `services/backups.ts` `VALID_SETTINGS_KEYS` in `validateBackupData()`

Deep-merge protected against prototype pollution (`__proto__`, `constructor`, `prototype`, `__defineGetter__`, etc.).

## Backup validation — `backups.ts::validateBackupData`

Add new entries here or restore silently rejects valid backups:

- `VALID_TYPES` — document types
- `VALID_SETTINGS_KEYS` — settings keys
- `VALID_ENTITY_TYPES` / `VALID_ACTIONS` — audit-log
- `BUILT_IN_TEMPLATE_IDS` (currently `itcake`)
- `replaceTables` in `restoreBackup()` — RMM tables (`agents`, `agent_metrics`, `agent_metrics_daily`, `agent_commands`, `agent_services`, `agent_packages`, `agent_schedules`, `agent_events`, `agent_enrollment_tokens`, `alert_rules`)

## DB tables

`users` (totp_secret/totp_enabled/totp_recovery_hashes), `sessions`, `documents`, `settings`, `changes` (audit + chained hash), `counters`, `rate_limits`, `monitors`, `monitor_checks` (48h), `monitor_daily` (forever), `agents` (last_auto_update_at, tags), `agent_enrollment_tokens`, `agent_metrics` (48h), `agent_metrics_daily` (forever), `agent_commands`, `agent_services`, `agent_packages`, `agent_schedules`, `agent_events`, `alert_rules`.

Counter keys: `invoice_global`, `proposal_global`, `client_global`, `ticket_global`, `agent_global`. New numbered entity → seed counter in `db.ts`. `incrementCounterWithMin(key, minValue)` + `resolveIdFormat(format, number)`.

## Environment variables

| Variable | Default | Purpose |
| --- | --- | --- |
| `DATABASE_PATH` | `data/itcake.db` | SQLite path |
| `DATA_DIR` | `data` | Uploads, backups, agent-binaries |
| `HOST` / `PORT` | `127.0.0.1` / `3000` | Bind |
| `ORIGIN` | — | Required in prod for CSRF |
| `NODE_ENV` | — | `production` enforces secure cookies + `SESSION_SECRET` |
| `SESSION_SECRET` | — | HMAC for sessions/at-rest enc; ≥32 chars in prod |
| `PUPPETEER_NO_SANDBOX` | `false` | `true` for Docker/root |
| `ADDRESS_HEADER` | — | Real IP behind proxy |

SMTP configured in-app, not via env.

## Commands

```sh
npm run dev | build | start | check | test
npm run build:agent | build:agent:all
```

## Conventions

- All DB mutations in `db.transaction()`. Audit log via `recordChange()`.
- Status transitions: `validateTransition<S>(map, current, target, label)` in `document-helpers.ts`.
- API routes: `parseJsonBody()` (1 MiB cap) + Zod. LIKE search escapes `%`, `_`, `\` with `ESCAPE '\'`.
- CSRF: Origin/Referer in `hooks.server.ts` for state-changing requests (`/api/rmm/*` exempt — bearer auth).
- File uploads: magic-byte verification, path-traversal guards, extension allowlists.
- EJS: built-in trusted; custom sandboxed (allowlist + prototype-free + deep-frozen + JS disabled in Puppeteer); option keys `/^[a-zA-Z][a-zA-Z0-9_]*$/`.
- PDF: Puppeteer with JS **disabled** + request interception blocking non-`data:` URLs. Logos converted to `data:` in template-context. Concurrency: 4-page semaphore + browser-launch mutex.
- DNS-pinned SSRF protection via `resolveAndValidate()` — covers IPv4 private/reserved, IPv6 loopback/link-local/ULA/mapped/NAT64/6to4/Teredo. Used by ping/HTTP/SSL/RDAP (each redirect re-validated; max 5 hops).
- Field crypto: `enc:` (v1) / `enc2:` (v2) coexist; next write re-encrypts as v2. No-op without `SESSION_SECRET`.
- Audit log tamper-evidence: `changes.hash` HMAC chain keyed by `SESSION_SECRET`. `verifyAuditLogIntegrity()` + `GET /api/changes/integrity`. Rows immutable.
- Binary integrity: `/api/rmm/download/:os/:arch` emits `X-Binary-SHA256` + RFC 9530 `Content-Digest`.
- HSTS includes `preload` in prod. API JSON: `Cache-Control: no-store`. Plus `Cross-Origin-Resource-Policy: same-origin`, `X-DNS-Prefetch-Control: off`, expanded `Permissions-Policy`.
- RMM agent endpoints return `json({error}, {status})` — never `throw error()` (agents parse JSON, not HTML).
- RMM enrollment rate-limited (10/IP/15min). Validators in `src/lib/validators-rmm.ts`.
- `processCommandResult(commandId, agentId, ...)` requires `agentId` — prevents cross-agent spoofing.
- Session tokens: `crypto.timingSafeEqual` over all active sessions.
- Notification error persistence: Telegram/email failures write `uptime.lastNotifyError`; cleared on next success.
- Backup restore: explicit column mapping via `PRAGMA table_info` when schemas differ; rejects DBs with triggers/views; ticket descriptions re-sanitized.
- Agent re-enrollment (same hostname+os+arch) deletes the old agent row first — invalidates old bearer + HMAC.

## RMM agent security

Privileged service: LaunchDaemon / systemd / SCM (LocalSystem / root).

**Enrollment:** operator generates 15-min single-use token → agent generates 32-byte hex `hmacSecret` via `crypto/rand` → posts `{token, hostname, os, arch, hmacSecret}`. Server stores `hmacSecret` verbatim (HMAC needs key on both ends) and bearer token as HMAC-SHA256 hash. Config AES-GCM encrypted with machine-id-derived key (Linux `/etc/machine-id`, macOS IOPlatformUUID, Windows MachineGuid). Optional `--pin-tls` captures leaf SPKI (survives renewal, breaks on key rotation); `--insecure` is enrollment-only, never persisted.

**Command dispatch:** `{ id, agentId, type, payload, payloadRaw, signature, issuedAt, timeoutSeconds }`. Signature = HMAC over `id:agentId:type:payloadRaw:issuedAt`. Agent verifies: agentId match, signature, ±10 min replay window, replay cache. `payloadRaw` is verbatim DB bytes — re-serializing breaks byte-stability.

**Privilege:** macOS/Linux `Execute()` drops to console user via `sudo -u`; `ExecuteAsRoot()` for `/Applications` removal / OS updates (brew/npm/pip refuse root). Windows: `cmd.exe /d /s /c` + `CREATE_NO_WINDOW`, already root, no scoop in SYSTEM context (refuses); PowerShell only when caller starts payload with `powershell`.

**Files:**

| OS | Binary | Config (AES-GCM) | Service | Log |
| --- | --- | --- | --- | --- |
| macOS | `/usr/local/bin/itcake-agent` | `/Library/Application Support/ITCake/agent-config.json` 0600 | `/Library/LaunchDaemons/com.itcake.agent.plist` | `/var/log/itcake-agent.log` |
| Linux | `/usr/local/bin/itcake-agent` | `/etc/itcake-agent/config.json` 0600 | `/etc/systemd/system/itcake-agent.service` | journald |
| Windows | `C:\ProgramData\ITCake\itcake-agent.exe` | `C:\ProgramData\ITCake\agent-config.json` | SCM `ITCakeAgent` (auto + recovery 5s/30s/2m) | Event Log + stdout to SCM |

**Self-update:** server sends `binaryHash` (SHA-256) on every checkin; agent downloads over pinned TLS, verifies hash, runs `--version` smoke, atomic rename, exits for service manager to restart.

**AV-friendliness:** no UPX/packers (90% trigger heuristics); `-trimpath -buildvcs=false`; Windows VERSIONINFO + manifest via `go generate ./cmd/agent`; metrics via Win32 APIs only at runtime (no WMI/PowerShell).

**Transport caps:** TLS 1.2+ enforced client-side; response 1 MiB; error 4 KiB; jitter ±10%; checkin payload caps stdout 1 MiB / stderr 256 KiB / packages 10k / services 1k.

## RMM settings (in `validators-rmm.ts`)

| Setting | Default | Range |
| --- | --- | --- |
| `defaultCheckinInterval` | 60 s | 10–3600 |
| `staleThresholdMinutes` | 5 | 1–60 |
| `metricsRetentionHours` | 48 | 1–720 |
| `commandTimeoutSeconds` | 300 | 5–3600 |

Status: `online` → `stale` (2× threshold) → `offline` (3× threshold).

## Background tasks (`hooks.server.ts`, all `setInterval(...).unref()`)

- 60 s — uptime checks · RMM stale detection · command expiry · cron-schedule dispatch
- 60 min — session cleanup · recurring invoices · overdue marking
- 1 h — RMM auto-update tick (per-agent interval)
- 24 h — prune audit log >1y · uptime daily aggregation/prune · RMM metrics daily/prune · agent-events prune

Overlap guards on `runChecks`/`runDailyChecks`.

## API auth groups

| Prefix | Auth | CSRF |
| --- | --- | --- |
| `/api/rmm/*` | Bearer | Exempt (agent-facing) |
| `/api/agents/*` | Cookie | Enforced (UI) |
| `/api/*` (other) | Cookie | Enforced |
| `/api/auth/*` | None | Enforced |
| `/api/config` | None | N/A (GET only) |

## MFA / TOTP

Two-step login. POST 1 = email+password → if MFA on, returns `{ mfaRequired, mfaToken }` (5-min stateless HMAC over `userId.expiresAt`). POST 2 = email+password+token+TOTP/recovery code. TOTP secret AES-GCM at rest; recovery codes HMAC-SHA256 hashed (keyed by `SESSION_SECRET`), consumed by `splice`. Disable requires password + TOTP/recovery. `signMfaChallenge`/`verifyMfaChallenge` in `lib/server/totp.ts`.

## Scheduled scripts

`agent_schedules` rows hold a 5-field cron expression (`*`, `N`, `N-M`, `N,M`, `*/N`). 60 s tick calls `processDueSchedules()` → `dispatchCommand()` (same HMAC pipeline). `next_run_at` precomputed on insert/update, rolled forward after each fire. Parser in `lib/server/cron.ts`.

## Event log collection

Agent reads level≥warning entries (journalctl / `log show` / wevtutil) once per 10 check-ins (rides inventory cycle so it doesn't fork a child every minute). Server stores in `agent_events`, prunes on same cadence as granular metrics (`metricsRetentionHours`).

## Software inventory delta

`agent-inventory.ts::upsertPackages` diffs each per-manager snapshot against the prior one and emits `agent_events` rows (level=warning, source=`package_change:<manager>`, message=`installed/removed/upgraded <name> ...`). The very first snapshot per (agent, manager) is suppressed when it consists entirely of installs above 5 packages — otherwise every package would look "newly installed". Hooks into the alerting engine via `agent_event` matching and into the Events tab UI.

## Alerting rules

`alert_rules` table; one row per rule, evaluated every 60 s in `hooks.server.ts → evaluateAlertRules()`. `condition` is JSON, discriminated by `kind`:
- `metric_threshold` — avg of metric (cpu/memory/disk %) over last `durationMinutes` crosses `op value`
- `agent_offline` — agent has been offline ≥ `durationMinutes`
- `agent_reboot_required` — `agents.data.rebootRequired = 1` (Windows only)
- `monitor_status` — uptime monitor in `down`/`error`

Cooldown is per-rule via `last_fired_at`; notifications reuse the uptime-settings Telegram + email channels. Dispatch is fire-and-forget so a slow channel doesn't block the tick. `tagAny` filter applies to all agent-scoped conditions.

## Agent tags + bulk dispatch

`agents.tags` is a JSON array (lowercase, `[a-z0-9_-]`, ≤50 chars, ≤30 tags). `setAgentTags()` normalizes and persists. `getAgentsByTags({any?, all?})` resolves a tag filter to enabled agents. `POST /api/agents/dispatch` (validated via `bulkDispatchSchema`) signs + queues a separate command per matched agent — each carries its own per-agent HMAC, so a compromised agent still can't replay against the others.

## Reboot

Command type `reboot` with payload `{ delaySeconds?: 0..86400, message?: string }`. Agent runs platform-native scheduled shutdown (`shutdown -r +<min>` on Unix, `shutdown.exe /r /t <sec> /f` on Windows) via `ExecuteAsRoot`. Delay defaults to 60 s so the agent can ack the result back to the server before the OS actually reboots — otherwise the result stays "running" forever.

## By design — not bugs (do not "fix" these)

- **Single-session enforcement** (`createSessionTx`) — single-user app.
- **HMAC-SHA256 session tokens with plain-SHA256 dev fallback** — prod rejects at startup if `SESSION_SECRET` missing.
- **0% tax groups filtered in display** — totals computed from unfiltered data first.
- **Credit note parent item negation as no-op** — `computeItemSubtotal` ignores parent qty when children exist; leaves correctly negated.
- **iframe `sandbox allow-same-origin`** on previews — CSP `default-src 'none'; script-src 'none'` prevents execution.
- **`backupInProgress` per-process** — single-process deployment.
- **RDAP manual redirect following** — each hop re-validated, max 5.
- **`translateServiceError` returns `never`** — catch blocks `return translateServiceError(e)` for control-flow.
- **`sentAt` sticky / `originalPaidDate` preserved on un-pay** — audit trail.
- **`kleinunternehmer` stored as explicit boolean** — distinguishes "explicitly not KU" from "pre-feature". Recurring uses `current.kleinunternehmer ?? false`.
- **`INVOICE_MUTABLE_FIELDS` / `PROPOSAL_MUTABLE_FIELDS` allowlists** — new fields immutable by default.
- **Open tickets convertible to invoices** — friction reduction; ticket marked `invoiced` either way.
- **`updateInvoice` does not handle status changes** — exclusively via `updateInvoiceStatus`; API strips status from update payloads.
- **Agent shell commands run as console user, not root** — brew/npm/pip refuse root. `ExecuteAsRoot()` for `/Applications` / OS updates.
- **Agent re-enrollment replaces old agent** — invalidates old bearer + HMAC immediately.
- **Brew casks excluded from `apps` source** — uninstall paths differ (`brew --zap` vs deep cleanup).
- **Agent IP shows `::1` on localhost** — server prefers `localIp` from checkin payload.
- **Agent HMAC secret per-device, agent-generated, server stores verbatim** — NOT derived from `SESSION_SECRET`, so agent compromise can't forge cross-agent commands. Legacy agents fall back to `SESSION_SECRET` until re-enrolled.
- **Command `payloadRaw` verbatim on the wire** — `getPendingCommandsRaw()` preserves exact DB string; agent verifies original bytes.
- **`--insecure` enrollment-only**, never persisted. Combine with `--pin-tls` to capture and then enforce a self-signed cert.
- **Machine-bound config encryption is defense-in-depth, NOT a boundary against local root** — attacker can re-derive the key. Protects against casual exfiltration via whole-disk backups.
- **Windows service via SCM direct** — no NSSM/scheduled tasks. `svc.IsWindowsService()` detects context; foreground `run` for debugging. `SetRecoveryActions` failure non-fatal.
- **No binary packing (UPX etc.)** — packed binaries trigger Defender/Kaspersky/ClamAV ~90%.
- **`rebootRequired` is a Windows-only current-state flag** on `agents.data.rebootRequired`, not in metrics table.
- **`last_auto_update_at` is dedicated column** — `updated_at` is bumped every check-in and would reset the auto-update clock.
- **Audit log pre-migration rows have empty `hash`** — counted as `unverified`, not `tampered`.
- **Rotating `SESSION_SECRET` invalidates** audit-log hashes, sessions, encrypted fields, TOTP recovery hashes, MFA challenge tokens. Don't rotate without a planned migration.

## Upstream advisories (informational only)

- `cookie <0.7.0` (GHSA-pxg6-pf52-xh8x) via `@sveltejs/kit` — near-zero exposure.
- `yauzl <3.2.1` (GHSA-gmq8-994r-jv83) via `puppeteer` — not used for user ZIPs.
