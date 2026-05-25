# ITCake

Single-user self-hosted web app: invoicing, tickets/time-tracking, uptime monitoring, RMM (Go agent), remote desktop (Apache Guacamole).

## Stack

SvelteKit (Svelte 5) + adapter-node, TypeScript, `better-sqlite3` (WAL), Tailwind v4, Vite 7, Node ≥ 20. Zod 4, bcryptjs + HMAC-SHA256 sessions, Nodemailer, Puppeteer, EJS, sanitize-html, guacamole-lite. Go agent in `agent/` (own `go.mod`, `CGO_ENABLED=0 -trimpath -buildvcs=false -ldflags='-s -w'`).

Bare-metal / VM only — no Docker. Run `node build/index.js` under systemd/runit. Reverse-proxy in front of `HOST:PORT` for TLS. `DATA_DIR` is a writable filesystem path the process owns.

## Project structure

```
src/
  routes/
    (app)/                Authenticated pages. Layout mounts v2 Sidebar + CommandPalette + ⌘K.
    api/                  POST {action, ...} via handleActionPost
      rmm/                Bearer-only, CSRF-exempt (checkin, enroll, download)
      health/  healthz/   Liveness (cheap SELECT 1) · Readiness (DB + disk + puppeteer + shutdown)
      csp-report/         CSRF-exempt browser violation reports
    login/+page.server    Form-action twin of /api/auth/login
    remote-desktop/[token]/   Popup; loads guacamole-common-js
  lib/
    server/               DB / auth / crypto / changes (audit) / shutdown / log / task-runs /
                          error-reporter / rate-limit / startup-invariants
    components/ui/        v2 primitives (see Design system)
    components/shell/     Sidebar · TopBar · CommandPalette
    i18n/                 en.ts, de.ts, server.ts (translateServiceError)
    validators{,-auth,-settings,-rmm}.ts
  services/               Business logic (auth-mfa, agents, agent-commands/schedules,
                          backups, backup-offsite, audit-monitor, guacamole, settings, emails)
  components/             v1 form-context primitives — used INSIDE forms/modals for visual
                          cohesion until v2 ships Input/Select/TextArea/Modal
agent/                    Go RMM agent (own go.mod). cmd/agent + internal/{config,checkin,
                          commands,packages,metrics,svclist,eventlog,services}
tests/                    integration/lifecycle.test.ts (spawns vite dev) · unit/*.test.ts (vitest)
assets/
  templates/              Invoice/proposal EJS + master template
  templateStrings/{en,de}.json   PDF i18n
  design/handoff-v2/      v2 design spec (visuals — data + API still from /handoff/)
data/                     Runtime — itcake.db (WAL), uploads/, backups/, agent-binaries/, recordings/
scripts/rotate-session-secret.mjs   Offline SESSION_SECRET rotation; re-wraps every enc3: blob
docs/openapi.yaml         Stable external surface (health, healthz, csp-report, rmm/*, ai/cost, tasks)
.github/workflows/sbom.yml   Weekly CycloneDX SBOMs (npm + Go agent), 90 d artifact
```

## Design system (v2)

Tokens in `src/app.css` (surface / brand / severity / sidebar) + effects (`.shadow-card`, `.shadow-pop`, `.stripes`, `.stripes-brand`, `.skeleton`, `.num`). v1 aliases point at v2 vars so unmigrated pages still render.

Primitives are server-render-tested in `tests/unit/ui-primitives.test.ts` (beforeAll-hoisted compile so the cold lucide-svelte transform doesn't time out). **When adding a primitive, add it to the test's `PRIMITIVES` array.**

**Form-cohesion rule.** Pages render v2 primitives end-to-end, BUT components that are themselves a form/modal (TicketForm, MonitorForm, EmailPreviewModal, LineItemEditor, DiscountEditor, ToInvoiceModal, UptimeSettingsForm, settings sub-sections that bind v1 Input/Select/TextArea) keep v1 Button/Toggle internally so visual rhythm matches the surrounding inputs. Migrate only once v2 ships Input/Select/TextArea/Modal.

Status palette (`06-status-system.md`): `good` paid/online/pass · `warn` stale/near-due · `bad` overdue/offline/critical · `accent` recurring/scheduled/viewed · `brand` primary positive · `neutral` informational. No other status colours allowed.

## Working with this codebase

- **Subagents.** Opus or Sonnet only. Never Haiku — too dumb for security audits / refactors / cross-file reasoning. If a task is large enough that you'd consider Haiku for cost, ask the user first.
- **Tests are mandatory.** Every behaviour change ships with a test in `tests/integration/lifecycle.test.ts` or `tests/unit/`. No exceptions.
- **Comments off by default.** Write one only when its absence would let a future change cause a real bug — a workaround for a known external-library bug (cite version), a TS quirk that's fixable but obscure, a hidden constraint the type system can't express. NOT for "explaining the design", NOT for security rationale obvious from the code, NOT for "because X" prose. The why goes in the commit message.
- **Refactoring.** Bugs before structure. High-value reads: (i) duplicated logic that has drifted (money rounding, path-traversal guards, validator regexes, allow/deny lists), (ii) numeric off-by-one (clamps missing at storage boundaries, integer divisions that should be Math.ceil, tax-rounding remainders), (iii) comment claims that contradict the code, (iv) error paths that re-issue a consumed credential or skip a transaction, (v) dead code. Extract a helper / hoist a constant only when it removes drift bug-bait, makes a single source of truth the type system / tests can't enforce, or earns one canonical name. LoC parity is fine — correctness is the win.

## Architecture invariants

Intentional for a single-user self-hosted app — don't swap for ORM / session library / Postgres. Flag bugs in the pattern, not the pattern.

- Raw prepared SQL against a JSON-in-SQLite document store. No ORM.
- Custom HMAC-SHA256 session tokens, single active session per user.
- Money: integer cents everywhere, never float. `computeInvoiceTotals` absorbs discount-rounding remainder into the largest tax group.
- Uptime + RMM use dedicated tables (time-series needs range queries).
- Two auth groups: bearer on `/api/rmm/*` (CSRF-exempt, JSON errors); cookie session everywhere else (CSRF-enforced). `/api/auth/*` pre-auth.

## Document store + mutation routing + i18n

`documents(id, type, data JSON, created_at, updated_at)`. Helpers in `db.ts`: `getDocument`, `getDocumentsByType` (10k cap), `insertDocument`, `updateDocument`, `deleteDocument`. Filter on `type` + `json_extract(data, '$.field')` with expression indexes. `custom_field_def` and `saved_filter` live here too for backup/audit parity.

Two mutation paths — don't mix:
- **API routes** (`/api/*`) — `POST { action: 'update'|'delete', id?, ...data }` (default = create). Used by `fetch()`. **Ticket → invoice is the JSON `POST /api/tickets {action: 'toInvoice'}` path, not a form-action.**
- **Form actions** (`?/name` on page servers) — status transitions, credit notes, proposal → invoice conversion. Used by `<form>`.

| i18n system | Files | Function |
| --- | --- | --- |
| UI | `src/lib/i18n/{en,de}.ts` | `t('key')` reactive store |
| Server errors | `src/lib/i18n/server.ts` | `serverT(lang)('key', { params })` |
| PDF templates | `assets/templateStrings/{en,de}.json` | `t('key')` in EJS |

`throw new ServiceError('error.key', { detail })`; translated at API boundary via `translateServiceError`. `tests/unit/i18n-parity.test.ts` enforces key-set + placeholder parity for UI + PDF strings.

## Allowlists — update them all when adding a key/type/table

| Adding | Update |
| --- | --- |
| Settings key | `db.ts` `defaultSettings` + `lib/server/backup-allowlists.ts` `BACKUP_VALID_SETTINGS_KEYS` (one source consumed by `services/settings.ts`, `services/backups.ts`, `services/backup-verification.ts`) + section schema in `routes/api/settings/+server.ts`. If encrypted credential: `db.ts` `SETTINGS_CREDENTIAL_AADS` + `encryptSettingsFields` + `decryptSettingsFields` switches + mask + mask-preserve handling in `services/settings.ts` |
| Document type | `documents` CHECK + `lib/server/backup-allowlists.ts` `BACKUP_VALID_DOCUMENT_TYPES` + rebuild CHECK + `__type_check_*` probe loop |
| Audit entity/action | `lib/server/changes.ts` `ChangeEntityType`/`ChangeAction` + `lib/server/backup-allowlists.ts` `BACKUP_VALID_ENTITY_TYPES`/`BACKUP_VALID_ACTIONS` + (HTTP mapping) `request-utils.ts` `SERVICE_ERROR_STATUS` |
| Collector kind | `db.ts` `agent_collector_results.kind` CHECK + rebuild CHECK + `lib/types.ts` `CollectorResultKind` + `lib/server/collector-tables.ts` `COLLECTOR_TABLES` |
| RMM table | `replaceTables` in `restoreBackup()` |
| Alert action type | `validators-rmm.ts` `alertActionSchema` + `services/alerts.ts` `runAlertActions` switch + `lib/types.ts` `AlertAction` |
| Agent command type | `validators-rmm.ts` `commandTypeEnum` + `scheduleTypeEnum` + `db.ts` `agent_commands` CHECK + rebuild CHECK + `agent_schedules` CHECK + rebuild CHECK + `lib/types.ts` `AgentCommandType` + Go `checkin.go` dispatch switch |
| Finding category | `db.ts` `agent_findings.category` CHECK + `lib/types.ts` `FindingCategory` |
| Numbered entity | seed counter in `db.ts` (`invoice_global`, `proposal_global`, `client_global`, `ticket_global`, `agent_global`) |

Settings deep-merge protected against prototype pollution (`__proto__`, `constructor`, `prototype`, `__defineGetter__`, …).

## Environment variables

| Variable | Default | Purpose |
| --- | --- | --- |
| `DATABASE_PATH` | `data/itcake.db` | SQLite path |
| `DATA_DIR` | `data` | Uploads, backups, agent-binaries, recordings |
| `HOST` / `PORT` | `127.0.0.1` / `3000` | Bind |
| `ORIGIN` | — | Required in prod for CSRF |
| `NODE_ENV` | — | `production` enforces secure cookies + `SESSION_SECRET` |
| `SESSION_SECRET` | — | HMAC for sessions / at-rest enc; ≥32 chars in prod |
| `ADDRESS_HEADER` | — | Real IP behind reverse proxy |
| `TRUST_PROXY` | — | Lets `ADDRESS_HEADER` coexist with non-loopback `HOST` (`assertProductionInvariants` refuses the combo without it) |
| `LOG_LEVEL` | `info` (`debug` in dev) | NDJSON logger level |
| `ITCAKE_UPDATE_MANIFEST_PUBKEYS` | — | Comma-sep base64 raw 32-byte Ed25519 pubkeys. Agents require matching signature when set |

SMTP, Telegram, off-site backup, Guacamole configured in-app, not via env.

## Conventions (surprising / non-obvious only)

- All DB mutations in `db.transaction()`; audit log via `recordChange()` inside the same transaction.
- API routes: `parseJsonBody()` (1 MiB cap) + Zod. `<Schema>.partial()` updates MUST go through `parseUpdateBody()` — Zod 4 partial keeps defaults, so a PATCH overwrites every absent field otherwise. Action-router routes dispatch via `handleActionPost`.
- LIKE search: escape `%`, `_`, `\` with `ESCAPE '\'`.
- CSRF: Origin/Referer in `hooks.server.ts`. `/api/rmm/*` exempt (bearer + JSON errors).
- File uploads: magic-byte verify, `O_NOFOLLOW`, `path.resolve` + `startsWith`, extension allowlist. SVG rejected.
- EJS: built-in trusted; custom sandboxed (allowlist + prototype-free + deep-frozen + JS-disabled Puppeteer + non-`data:` request interception). Logos baked to data URIs.
- SSRF: `resolveAndValidate()` covers IPv4 private/reserved + IPv6 loopback/link-local/ULA/mapped/NAT64/6to4/Teredo. Used by ping/HTTP/SSL/RDAP (per-redirect re-validation, max 5 hops). SMTP/S3/WebDAV/Telegram/Anthropic pin the resolved IP via custom `lookup` agents (`pinnedHttpsRequest` / `pinnedHttpsAgent`).
- Monitor `ip` field rejects blocked ranges at create/update via `rejectBlockedMonitorIp` (not just at probe).
- Backup restore: explicit column mapping (`PRAGMA table_info`), rejects DBs with triggers/views, ticket descriptions re-sanitised, `mfa_step_up_used_codes` + `mfa_used_challenges` + `sessions` cleared.
- `processCommandResult(commandId, agentId, ...)` requires `agentId` — prevents cross-agent spoofing.
- Go agent shell-outs go through `syspath.*()` absolute paths on every OS. Bare-name fallbacks are PATH-hijack vectors as root.

## Encryption — what's encrypted where

All `enc3:` ciphertexts are AES-256-GCM via `field-crypto.ts` (HKDF + per-blob salt + AAD), keyed by scrypt-derived `SESSION_SECRET`. AAD binds the ciphertext to its identity — cross-row copy fails GCM verify. Legacy `enc2:` (no AAD) still readable on first boot; `migrate*ToV3` re-wraps with the right AAD. Unknown `encN:` → fail-closed `''` with log.

| Surface | AAD / scheme |
| --- | --- |
| Session/bearer tokens, recovery code hashes, MFA-challenge nonces, step-up replay cache | HMAC-SHA256(`SESSION_SECRET`, …) — irreversible |
| Settings credentials | `enc3:` AAD `<path>:1` for: `emails.smtp.pass`, `uptime.telegram.botToken`, `ai.apiKey`, `backup.encryptionPassphrase`, `backup.offsite.s3.secretAccessKey`, `backup.offsite.webdav.password`, `rmm.updateManifestPrivateKey`, `telemetry.errorReportingDsn`. Canonical map: `SETTINGS_CREDENTIAL_AADS` in `db.ts`. Boot-time `repairLegacyEnc3SettingsAad()` self-heals bare-label AAD from old migration |
| Per-row credentials | `enc3:` AAD `agent.hmacSecret:<id>`, `agent.remoteDesktop.{password,privateKey}:<id>`, `users.totpSecret:<id>` |
| Backup ZIP (optional) | AES-256-GCM via `backup-crypto.ts` (scrypt N=2¹⁷, v2 header; v1 still readable). `.zip.enc`. Independent of `SESSION_SECRET`. Passphrase ciphertext **elided from the in-zip settings row** so a leaked archive isn't self-decryptable |
| Audit log | Per-row HMAC chain + `audit_anchor` HMAC + `audit_anchor_history` (per-snapshot HMAC keyed to `captured_at`). `verifyAuditLogIntegrity()` reports `tamperedIds` and `anchor: ok|tail-truncated|mismatch|none` plus `historyTruncationDetected` |
| Agent config on disk | AES-GCM keyed by machine-id (Linux `/etc/machine-id`, macOS IOPlatformUUID, Windows MachineGuid). 0600 perms / Windows ACL. Defense-in-depth — NOT a boundary against local root |
| Self-update | Per-agent HMAC advisory `binary-advisory:agentId:hash:issuedAt` (mandatory) + optional Ed25519 manifest signature when `ITCAKE_UPDATE_MANIFEST_PUBKEYS` is set. `X-Binary-SHA256` + RFC 9530 `Content-Digest` cross-checked |

Masks: `ai.apiKey`, `telemetry.errorReportingDsn`, S3/WebDAV/SMTP/Telegram creds all return `••••••••` / `***` in GET; POSTing the same mask preserves prior. Strict-mode rejects plaintext-downgrade. Audit-log diff masks `apiKey` + `rmm.updateManifestPrivateKey` on update so a session-only attacker reading `/api/changes` can't recover the key from a rotation entry.

## Response headers

HSTS includes `preload` in prod. API JSON: `Cache-Control: no-store`. Plus `Cross-Origin-Resource-Policy: same-origin`, `X-DNS-Prefetch-Control: off`, expanded `Permissions-Policy`. CSP via SvelteKit nonce-based config (`svelte.config.js`) + `/api/*` fallback in `hooks.server.ts` — explicit `worker-src 'none'`, `manifest-src 'self'`, `media-src 'none'`, `frame-src 'self'`, `child-src 'self'`. Both CSPs append `report-uri /api/csp-report` (16 KiB cap, per-IP 60/min, CSRF-exempt, always 204, log only).

## AI brain

BYOK Anthropic-API assistant gated by server-side **risk tier** + **operator approval**. Disabled by default; enable + paste API key in Settings → AI.

**Consultant mode (default).** `settings.ai.consultantMode = true` makes the AI strictly read-only — reads tickets + telemetry, summarises, proposes draft responses; CANNOT dispatch / mutate / reach client machines. Two layers: `getToolDefinitionsForMode({ consultantMode: true })` filters the tool list shown to the model; `checkGuardrails` hard-blocks any tier > 1 call at tier 4 even if the model constructs it. Operator must explicitly flip `consultantMode=false` to re-enable dispatch.

**Tier resolution.** Direct `@anthropic-ai/sdk` Messages API + manual tool loop (no Agent SDK). `checkGuardrails(toolName, input, mode, { consultantMode })` returns Tier 1..4 with action-level overrides (e.g. `dispatch_agent_command:shell` = Tier 3; `:system_info_refresh` = Tier 2). Unknown tool names AND unknown command actions fail-closed to Tier 4. `TOOL_TIERS` pinned by `ai-brain.test.ts` parity test against `getRegisteredToolNames()`.

**Approval gate.** Tier 3 (and Tier 2 in `per_step` mode) inserts `ai_tool_executions` row `status='pending'` and awaits an in-memory `Map<executionId, resolver>`. SSE `approval_required`; operator POSTs `/api/ai/sessions/:id/approvals`. 5-min reaper auto-rejects stale. On module load, `abortOrphanedPlans` expires stale `plan_steps` AND `ai_tool_executions` so a process restart doesn't strand the UI.

**Output safety.** `compactToolResultForChat` two-pass shrink (1.5KB/60/6-deep → 700/20/4) + secret regex (Anthropic/OpenAI/GitHub/AWS/Slack/Stripe/Twilio/SendGrid/Azure-conn/GCP-svc/JWT/PEM). `SCRIPT_BODY_FIELDS` (`scriptContent`/`command`/`payloadRaw`/etc.) > 200 chars omitted. `redactSensitiveInput` walks tool inputs before SSE AND audit row.

**Input safety.** `sanitizeUserText` rejects 11 prompt-injection patterns + strips bidi/zero-width/U+2028/2029/180E. NFKC + Cyrillic/Greek homoglyph fold so `іgnоrе previous instructions` is caught. 10 KiB cap. `sanitizePageContext` recurses.

**Cost + turn cap.** `claimTurnSlotIfWithinBudget` is one `db.transaction`: budget + atomic `UPDATE … SET turn_count = turn_count + 1 WHERE id = ? AND turn_count < ?`. Concurrent POSTs can't both pass. 50 turns/session, 10-iter tool loop, 16K `max_tokens`/turn. Usage → `ai_cost_daily` (UTC); default $50/month budget refuses turns at `monthToDate >= limit`. Model allowlist `{opus-4-7, opus-4-6, sonnet-4-6, haiku-4-5}` enforced by `aiSettingsSchema`.

**Plan mode.** `propose_action_plan` lets the model propose ≤25 `{toolName, input, rationale}` steps; operator approves once (with optional `editedSteps`). Subsequent calls auto-execute when they match the next step on tool name AND KEY_FIELDS (`agentId`/`action`/`scriptId`/`policyId`/`monitorId`/`ticketId`/`invoiceId`/`clientId`/`filename`). Per-action payload pinning via `DISPATCH_PINNED_KEYS_BY_ACTION`. `matchPlanStep` is **symmetric** on KEY_FIELDS — a call carrying a value where the plan didn't pin one is a mismatch (otherwise "look up any ticket" would auto-approve "delete every ticket"). `validatePlanStep` also rejects propose-time plans where the documented key isn't pinned: **`dispatch_agent_command` requires `agentId`+`action`+per-action payload keys**, and **`verify_backup_integrity` / `run_backup_test_restore` require `filename`** so the operator approves a concrete backup. Plan timeout 10 min.

**`AI_REFUSED_ACTIONS`.** `dispatch_agent_command` MUST NOT carry `filesystem_cleanup` from the AI surface — that endpoint requires per-call MFA step-up the AI can't provide. Hard-blocked at handler entry.

**Storage.** `ai_sessions` + `ai_messages` (full transcript inc. tool_use/result blocks, resume-safe) + `ai_tool_executions` + `ai_cost_daily`. User-scoped. Session create + approval decisions go through `changes` HMAC chain.

**Adding a tool.** Create `src/lib/server/ai/tools/<domain>.ts`, call `registerTool(name, {definition, handler})`, add to `TOOL_TIERS` in `guardrails.ts`, import from `tools/index.ts`. Parity test flags drift either way.

## RMM

Privileged service: LaunchDaemon / systemd / SCM (LocalSystem / root).

**Enrollment.** Operator generates 15-min single-use token → agent generates 32-byte hex `hmacSecret` via `crypto/rand` → posts `{token, hostname, os, arch, hmacSecret}`. Server stores `hmacSecret` `enc3:` AAD `agent.hmacSecret:<id>` and bearer as HMAC-SHA256 hash. Local config AES-GCM under machine-id key. `--pin-tls` captures leaf SPKI; `--insecure` enrollment-only, never persisted.

**Command dispatch.** `{ id, agentId, type, payload, payloadRaw, signature, issuedAt, timeoutSeconds }`. Signature = HMAC over `id:agentId:type:payloadRaw:issuedAt` keyed by per-agent secret. Agent verifies: agentId match, signature, ±10 min replay window, persistent replay cache (`replay-cache.json`, survives restart). **`payloadRaw` is verbatim DB bytes — re-serializing on either side breaks signature.**

**Privilege.** macOS `Execute()` drops to console user via `sudo -u` so brew/npm/pip find that user's profile. Linux `Execute()` runs as service identity (root under systemd); `packages.ConsoleUser` consults `$SUDO_USER` only for brew/npm/pip command-string construction. `ExecuteAsRoot()` for `/Applications` removal / OS updates / reboot. Windows `cmd.exe /d /s /c` + `CREATE_NO_WINDOW`, already root.

**Self-update.** Server emits `binaryHash` + per-agent HMAC advisory `binary-advisory:agentId:hash:issuedAt` every checkin. Agent verifies advisory (±10 min skew), downloads over pinned TLS, verifies SHA-256 + RFC 9530 `Content-Digest`, runs new binary's `version` as smoke test, atomic rename, exits for service manager. Pre-flight `checkBinaryPathWritable` aborts before 50 MB download on `ProtectSystem=strict`. Linux/macOS `os.Remove` before rename to avoid ETXTBSY.

Optional **Ed25519 manifest signature** (additive; HMAC advisory still mandatory). Server keypair in `settings.rmm.updateManifestPrivateKey` (`enc3:` AAD `rmm.updateManifestPrivateKey:1`). When configured, checkin response includes `binaryManifestSignature = ed25519(privKey, "binary-manifest:<agentId>:<binaryHash>:<issuedAt>")`. Agents with at least one pubkey in `ITCAKE_UPDATE_MANIFEST_PUBKEYS` require verify; without pubkeys, field ignored (backward compat). Manage via `POST /api/agents/update-manifest-key { action: 'generate'|'rotate'|'remove'|'status' }` (cookie + CSRF). A CA-trusted MITM with the per-agent HMAC still can't substitute the binary on agents that have the pubkey deployed.

**Status.** `online` → `stale` (2× threshold) → `offline` (3× threshold). Defaults in `db.ts#defaultSettings.rmm` (no `rmmSettingsSchema` today — operator edits DB row directly): `defaultCheckinInterval` 30s, `staleThresholdMinutes` 2 (clamped 1–60 in `detectStaleAgents`), `metricsRetentionHours` 48, `commandTimeoutSeconds` 300, `postureCacheTtlSeconds` 300.

**Transport caps.** TLS 1.2+ client-side; response 1 MiB; error 4 KiB; jitter ±10%; checkin caps stdout 1 MiB / stderr 256 KiB / packages 10k / services 1k.

**AV-friendliness.** No UPX/packers; `-trimpath -buildvcs=false`; Windows VERSIONINFO + manifest via `go generate ./cmd/agent`; metrics via Win32 APIs only at runtime (no WMI/PowerShell).

| OS | Binary | Config (AES-GCM) | Service | Log |
| --- | --- | --- | --- | --- |
| macOS | `/usr/local/bin/itcake-agent` | `/Library/Application Support/ITCake/agent-config.json` 0600 | `/Library/LaunchDaemons/com.itcake.agent.plist` | `/var/log/itcake-agent.log` |
| Linux | `/usr/local/bin/itcake-agent` | `/etc/itcake-agent/config.json` 0600 | `/etc/systemd/system/itcake-agent.service` | journald |
| Windows | `C:\ProgramData\ITCake\itcake-agent.exe` | `C:\ProgramData\ITCake\agent-config.json` (icacls SYSTEM+Admins only) | SCM `ITCakeAgent` (auto + recovery 5s/30s/2m) | Event Log + stdout |

Go silently ignores Windows file modes — `lockdownPath` in `agent/internal/config/acl_windows.go` shells out to `icacls.exe`.

**Features.** Scheduled scripts (5-field cron UTC; same HMAC pipeline). Event log collection (level≥warning, journalctl/`log show`/wevtutil, once per 10 check-ins). Software inventory delta. Alert rules (`metric_threshold` / `agent_offline` / `agent_reboot_required` / `monitor_status`, per-rule cooldown via `last_fired_at`). Tags + bulk dispatch (`agents.tags` JSON; `[a-z0-9_-]` ≤50 chars, ≤30 tags; each match gets its own HMAC). Reboot (`{ delaySeconds 0..86400, message }`).

**Telemetry collectors.** Each via `POST /api/agents/[id]/<feature> {action}`, snapshots in `agent_collector_results` keyed by `kind`, findings in `agent_findings` with stable fingerprints for dedup:

- **Reliability** (`reliability_daily`, ≤90d) — `computeScore` weights uptime 30 / crashes 25 / hangs 15 / serviceFailures 15 / hardwareErrors 15. `computeAggregateScore` = score + 30d slope + 90d MTBF.
- **Peripheral inventory** — detection only. Server `evaluateDevice` mirrors Go-side eval; server verdict drives findings. Policy in `agents.data.peripheralPolicy`.
- **Sensitive data scan** — detection only. Regex catalogue: SSN / email / PCI (Luhn) / PHI / AWS / private keys / secret assignments / IBAN. NUL-byte skip; 64KiB chunks + 256-byte overlap. SSN/PCI digit-masked.
- **Filesystem analysis + cleanup** (`filesystem_analysis` Tier 1 / `filesystem_cleanup` Tier 3) — `filescan.Walk` via `workerpool` (default 4, max 16). Cleanup gated: absolute paths only, refuses post-`EvalSymlinks` into `/etc /usr /bin /sbin /lib /boot /var/log /Applications /System C:\Windows C:\Program Files`, refuses owner-mismatch unless root/SYSTEM, refuses >1 GB. **Fresh TOTP/recovery on every call** when MFA on. `AI_REFUSED_ACTIONS` blocks AI dispatch.
- **Network discovery + baseline** — ARP + ping/TCP fallback + port scan + reverse DNS + compiled-in OUI top-200. Drift findings: `new_device` (medium), `device_disappeared` (low, 24h), `device_changed` (low). **Operator confirms baseline manually** — auto-baseline would let a LAN attacker poison the trusted view.
- **Boot performance** — Linux `systemd-analyze`, macOS `sysctl kern.boottime` + `log show`, Windows event 100. Slow-boot finding low @ >90s, medium @ >180s.
- **Hardware warranty** — SMBIOS / `system_profiler` + AppleCare cache glob / `Get-CimInstance`. Operator override wins. Findings low @ 90d, medium @ 30d, high once expired.
- **CIS hardening audit** — detection only. ~10 L1 checks/OS, CheckIDs match public CIS numbering. Engine has explicit `not_applicable` / `error` states.
- **Security posture aggregate** — server-only, 0..100 = `sensitive_data 25 + policy 20 + peripheral 15 + network 15 + filesystem 10 + reliability 15`. Severity-weighted (crit 100 / high 80 / med 50 / low 20). Cached 5 min, invalidated on finding state changes.

**Exports.** `GET /api/exports?kind={agents,findings,audit}` (RFC 4180 + UTF-8 BOM, `no-store`). `=`/`+`/`-`/`@`/`\t`/`\r` neutralised against Excel formula injection. `GET /api/exports/osquery` ships osquery-shape NDJSON (column names regex-validated at module load).

## First-time setup

`/` and `/login` both `hasUsers()`-redirect to `/setup` when DB has zero users. Two parallel paths:

- **Form** — `routes/setup/+page.server.ts`. Three-step UI (admin → company → preferences). `createFirstUserSafe` re-checks user count inside the transaction (concurrent losers get `REGISTRATION_CLOSED` → 403). Applies `company` / `general` / `invoices` / `proposals` defaults, auto-logs in, → `/dashboard`.
- **JSON** — `POST /api/auth/register { name, email, password, company? }`. Same atomic creation. Optional `company.name` (+ optional `company.email`) is the minimum for `isSetupComplete()` so `/api/config` stops reporting `needsSetup`. Without it, `setupComplete: false`. Rate-limited 10 / 15 min / IP via `checkAndRecordSetupAttempt`.

Setup form auto-detects timezone, falls back to `Europe/Berlin` if not in curated `timezoneOptions`. **MFA NOT enforced at setup** — Settings → Security MFA is the post-setup enrollment surface; the runbook's endpoint-compromise row assumes MFA is enabled.

## MFA / TOTP

**Two-step login.** POST 1 (email+password) → `{ mfaRequired, mfaToken }` (5-min HMAC over `userId.expiresAt.nonce`, single-use via `mfa_used_challenges`). POST 2 (email+password+mfaToken+code) — **password re-verified on step 2** (otherwise mfaToken is a bearer credential); **mfaToken consumed on FIRST second-step attempt regardless of outcome** so a captured token isn't replayable for its 5-min TTL. TOTP secret `enc3:` AAD `users.totpSecret:<id>`; recovery codes HMAC-hashed, consumed via constant-time match + optimistic CAS. **Enable AND disable both require currentPassword** AND revoke all sessions in-transaction.

**Step-up replay cache.** Every `requireMfaStepUp`-gated endpoint (filesystem cleanup, backup delete/restore, manifest-key generate/rotate/remove, remote-session create, password change, MFA disable) burns the consumed TOTP into `mfa_step_up_used_codes` (HMAC-SHA256 keyed by `SESSION_SECRET`, 90s prune). Login also burns its TOTP (best-effort). Rate-limited per user (`mfa-stepup:<userId>`): 5 *failed* codes per 15-min window; success doesn't burn a slot and clears the bucket. Failures-only counting closes the TOTP-validity oracle.

**Order in /api/auth/password and /api/auth/mfa disable.** `currentPassword` verified BEFORE `requireMfaStepUp` so a session-only attacker can't probe TOTP validity without knowing the password.

## Backup

**Local.** ZIP via `services/backups.ts`. Restore validates allowlists, explicit column mapping per `PRAGMA table_info`, rejects DBs with triggers/views, re-sanitises ticket descriptions, clears `mfa_step_up_used_codes` + `mfa_used_challenges` + `sessions`.

**Encryption** (optional). `settings.backup.encryptionPassphrase` → AES-256-GCM (scrypt N=2¹⁷, v2 header; v1 still readable). `.zip.enc`. Passphrase ciphertext **elided from the in-zip settings row**. `getBackupPassphrase` throws `BackupPassphraseUnreadableError` instead of falling back to plaintext.

**Off-site.** S3-compatible (manual SigV4, no aws-sdk dep) or WebDAV. Schedule `daily|weekly|manual`. Credentials `enc3:`-encrypted; `***` masked in GET, `***` POST preserves. `POST /api/backups/offsite { test|run: true }`. Pinned-IP `lookup` on every connection.

**Verification ladder.** `verifyBackupIntegrity()` runs after each off-site upload (decrypt → GCM tag → zip catalog → `PRAGMA integrity_check`). Weekly `runBackupTestRestore()` picks via `Math.floor(now/7d) % len`. `recomputeRecoveryReadiness()`: 30/25/25/20 pts (fresh local / integrity / test-restore <7d / off-site <24h), rebalanced when off-site disabled.

## Remote desktop (Apache Guacamole, baked in)

ITCake supervises guacd (installed via admin UI's OS package manager) and proxies WebSocket → guacd via guacamole-lite; browser uses guacamole-common-js.

**Lifecycle.** Operator clicks "Remote desktop" → `POST /api/agents/{id}/remote-session` (MFA-step-up) returns one-time HMAC-hashed token (5-min TTL). Browser opens `/remote-desktop/{token}` → WS `/api/remote-desktop/ws?token=…`. guacamole-lite validates, opens TCP to guacd (127.0.0.1:4822), forwards.

**Hardening.**
- guacd binds 127.0.0.1 only.
- Session tokens single-use: `consumeRemoteSession` CAS on `consumed_at IS NULL` at popup load; `claimRemoteSessionStart` CAS on `started_at IS NULL` at WS open.
- Per-agent profile (`agents.data.remoteDesktop`) holds **operator-set host** (NEVER agent-reported `agent.ip`), port, username, password (`enc3:` AAD-bound), ignoreCert, domain, optional privateKey.
- Encrypted Guacamole token carries `{ connection: { type }, itcakeSessionId }` only — credentials resolved server-side at WS-open. Bit-flipping yields JSON-parse failure or sessionId mismatch.
- WS Origin validated on upgrade.
- Recording (optional): `.guac` → MP4 via `guacenc` (`execFile`, no shell) on first playback. Refuses while `endedAt IS NULL`. Owner-only. Served as `attachment` to bypass strict `/api/*` CSP.
- Install/update: `POST /api/remote-desktop/guacd { action: install|update|status }`. Linux apt/dnf/pacman/apk; macOS brew. Windows unsupported upstream.

## Operator runbook

| Task | Steps |
| --- | --- |
| Revoke a compromised agent | `POST /api/agents` `{ action: 'delete', id }`. Invalidates bearer + HMAC instantly. Audit-logged. |
| Endpoint compromise (ransomware, theft, lateral movement) | Treat the box as totally lost. (1) Revoke the agent — bearer + per-row HMAC stop working server-side on next checkin. (2) Close any open remote-desktop popup. (3) Re-image the OS; do NOT trust files, packages, or existing agent install. (4) Re-enrol via fresh one-time token. (5) Rotate any credentials that ever transited that machine (RDP passwords on `agents.data.remoteDesktop`, secrets in tickets / collector results). Machine-bound config encryption keeps casual users out, NOT root. |
| Rotate compromised SESSION_SECRET | Preferred: stop → `node scripts/rotate-session-secret.mjs --db data/itcake.db --old <HEX> --new <HEX>` (dry-run first). Re-wraps every `enc3:` blob (settings creds, agent HMAC + RDP creds, TOTP secrets). Set new value in env → start. After restart: regenerate TOTP recovery codes (HMACs irreversible). Pre-rotation audit-log rows surface as unverified. Alternative (destructive): stop → swap → start; loses every field-encrypted value. |
| Rotate local-backup passphrase | `POST /api/backups { action: 'rotate_passphrase', password, newPassphrase }` (admin pwd + MFA step-up). Re-encrypts every `.zip.enc` per-file atomic; plaintext `.zip` skipped; corrupted / wrong-old land in `failed[]` without aborting. Settings update happens AFTER the rewrap so a partial rotation leaves every file decryptable with one of the two passphrases. |
| Restore from backup | UI → Backups → Restore. `.zip.enc` requires original passphrase. Backup contains current SESSION_SECRET-derived ciphertexts — restore on a different host without the same SESSION_SECRET makes encrypted fields unrecoverable. |
| Enable off-site backup | Settings → Backup → enable, choose S3 or WebDAV, fill creds, "Test connection", set schedule. Secrets stored encrypted; UI shows `***`. |
| Set a backup passphrase | Settings → Backup → enter passphrase. New ZIPs become `.zip.enc`. Old `.zip` stay readable. Changing locks out previously-encrypted backups — keep the old until those are rotated out. |
| Install/update Guacamole | Settings → Remote Desktop → "Install guacd" / "Update". Runs OS package manager. After install, supervisor binds 127.0.0.1:4822. `{ action: 'status' }` reports state on demand. |
| Audit-log integrity check | `GET /api/changes/integrity` → `{ total, verified, unverified, tamperedIds, anchor }`. Pre-migration rows = `unverified`. Pre-rotation rows = `tampered`. `anchor: 'tail-truncated'` / `'mismatch'` is a real incident unless preceded by a documented SESSION_SECRET rotation OR the most recent annual audit-log prune (the prune trims `audit_anchor_history` above the new live row count). Per-IP rate-limit tunable via `settings.advanced.auditIntegrityRateLimit` (default 10/min). |
| External monitoring | ITCake monitors others; have something else monitor ITCake. Point pingdom / uptimerobot / ohdear at `/api/health` (liveness) and a deeper check at `/api/healthz` (DB + disk + puppeteer + shutdown flag, 503 on any failure). |
| Deploy | bare-metal / VM. `npm run build`, run `node build/index.js` under systemd / runit. Persist `DATA_DIR`. Reverse-proxy (nginx, caddy, …) terminates TLS in front of `HOST:PORT`. Proxy on same loopback → leave `HOST=127.0.0.1`, skip `ADDRESS_HEADER`/`TRUST_PROXY`. Proxy on a different host → set `TRUST_PROXY=true` to acknowledge the proxy is the only thing reaching that port. |
| Enable opt-in error reporting | Settings → Telemetry → paste a Sentry DSN. Stored `enc3:` AAD `telemetry.errorReportingDsn:1`, masked in GET + audit-log diffs. `sampleRate` (0..1) gates a minimal Sentry-compatible envelope POST via `pinnedHttpsRequest`. Exception messages + stack frames + tag values run through `redactSensitiveInput` so token-shaped secrets become `[REDACTED:<kind>]`. **Non-token operator data (customer names, paths) can still appear.** |
| Inspect long-running task runs | `GET /api/tasks?limit=50` returns `task_runs` rows (`createBackup`, `restoreBackup`, `backup_passphrase_rotate`, `audit_integrity_check`). Pruned >90 d. |
| Rotate Ed25519 manifest pubkey | `POST /api/agents/update-manifest-key {action:'rotate'}` (admin pwd + MFA). Signs the new pubkey with the previous private key and stores the signed announcement in `settings.rmm.updateManifestRotationHistory` (capped at 5). Every agent picks up the announcement on its next checkin and merges the new pubkey into its persisted trust set (chained K0→K1→K2 verifies oldest-first). Agents that have been offline longer than 5 consecutive rotations must be re-enrolled by hand. |

## Background tasks

All `setInterval(...).unref()`, installed by `hooks.server.ts` (overlap guards on `runChecks` / `runDailyChecks`):
- **60 s** — uptime checks · RMM stale detection · command expiry · cron-schedule dispatch · alert evaluation · expired remote-desktop session-token cleanup
- **60 min** — session cleanup · recurring invoices · overdue marking
- **1 h** — RMM auto-update tick (per-agent interval)
- **24 h** — prune audit log >1y · uptime daily aggregation/prune · RMM metrics prune · agent-events prune · off-site backup tick · prune local backups (`pruneOldLocalBackups`: keepMin 7 + retentionDays 30) · audit integrity check (persists last-checked + anchor state + counts) · prune `task_runs` >90 d · `abortOrphanedPlans`

Module-local (also `.unref()`d): **30 s** AI approval-map reaper (`approval-map.ts`, 5-min stale sweep) · ws-tickets reaper.

## Shutdown coordinator

One `process.on('SIGTERM'/'SIGINT')` in `hooks.server.ts`. Subsystems register cleanup via `registerShutdownTask(name, fn, opts?)` (db.ts → wal_checkpoint + close; pdf.ts → puppeteer close). LIFO, 10 s per-task timeout. While `isShuttingDown()`, `handle` returns 503 + `Retry-After: 30` for every path except `/api/health` and `/api/healthz` so load balancers rotate traffic away.

## Operator visibility

- **Structured logger** (`log.ts`) — `log.{debug,info,warn,error}(msg, fields)` NDJSON to stdout/stderr; level from `LOG_LEVEL`. New paths go through it; legacy `console.error` not policed.
- **Task runs** (`task-runs.ts`, `GET /api/tasks`) — every long op wrapped in `recordTaskRun`; `running` on entry → `ok`/`error` on exit. Boot sweep marks stale `running` as errored.
- **Schema migrations** (`schema_migrations`) — `recordSchemaMigration(id, description)` writes one row per migration. CHECK-constraint rebuild blocks are idempotent SQL and NOT registered.
- **Audit integrity status** — `audit_integrity_status` single-row table, written by `runScheduledAuditIntegrityCheck`.
- **Disk usage** (`disk-usage.ts`) — `measureDataDirUsage()` walks per-category; `getFreeDiskSpace()` is the cheap statfs subset used by `/api/healthz`.
- **Health endpoints** — `/api/health` (liveness) and `/api/healthz` (deep) both bypass the global rate-limit + shutdown 503-gate.

## Rate-limit gate on `/api/*`

`checkAndRecordWindowed(key, max, windowMs)` in `rate-limit.ts` powers a per-IP gate in `handle`: **600 req / min / IP**. Exempt: `/api/rmm/*` (bearer; own transport caps), `/api/health`, `/api/healthz`, `/api/csp-report` (own 60/min cap). 429 returns JSON + `Retry-After`. Client IP is `event.getClientAddress()` — trustworthy because `assertProductionInvariants` rejects `ADDRESS_HEADER` outside loopback unless `TRUST_PROXY=true`.

## Multi-user prep (not yet a multi-user app)

`users.role` (`'admin' | 'user'`, default `'admin'`) added as schema_migration #2. `SessionUser` carries it; `requireAdmin(locals)` returns 403 on non-admins. Currently gating: `POST /api/settings`, `POST /api/uptime/settings`, `GET /api/changes`, `GET /api/changes/integrity`, `POST /api/backups/offsite`. Every other endpoint uses `requireUser`. Provisioning a `user`-role account has no UI yet; the column is dormant until a follow-up adds the invite/grant flow.

## Security model invariants

Load-bearing across multiple files. Changes here = security review, not refactor.

- **Agent HMAC secret AAD-bound per row** (`enc3:` AAD `agent.hmacSecret:<id>`). Cross-row copy fails GCM verify. Legacy empty `hmac_secret` → `signCommand` throws `LegacyEnrollmentError`; re-enrol.
- **Command `payloadRaw` verbatim on the wire.** `getPendingCommandsRaw()` returns exact DB bytes; agent re-HMACs them. Re-marshalling on either side breaks signature verification.
- **`--insecure` is enrollment-only, never persisted.** Pair with `--pin-tls` for capture-then-enforce.
- **Machine-bound config encryption is defense-in-depth, NOT a boundary against local root.** Windows ACL lockdown raises the bar for non-admin local users.
- **Encrypted Guacamole token carries no credentials.** Resolved server-side at WS-open via `processConnectionSettings(itcakeSessionId)`. Per-agent password/key AAD-bound. guacd host is operator-set, never `agent.ip` from the agent's own checkin.
- **Remote-desktop session tokens are bearer credentials, HMAC-SHA256-hashed at rest.**
- **Password change + MFA disable verify `currentPassword` BEFORE `requireMfaStepUp`** — closes the TOTP-validity oracle to a session-only attacker.
- **Recovery codes and step-up TOTP burn at the gate.** `requireMfaStepUp` is one atomic `db.transaction` covering rate-limit + verify + replay-cache insert + recovery-code consume + bucket clear. A subsequent transactional failure in the wrapped flow wastes the credential but never re-issues it.
- **SMTP / S3 / WebDAV / RDAP / HTTP / SSL / ping / Telegram / Anthropic all DNS-rebind-pinned.** `pinnedLookup` + `pinnedHttpsRequest` / `pinnedHttpsAgent` keep SNI on the hostname while dialing the validated IP.
- **Backup encryption is not silently downgradable.** Configured-but-unreadable passphrase throws; passphrase ciphertext elided from the in-zip settings row.
- **Audit anchor history HMAC keyed to `captured_at`** (matching the verifier). Old code reused the live anchor's HMAC keyed to `updated_at`, which silently failed verify outside a sub-ms timing window.
- **Go agent shell-outs go through `syspath.*()` absolute paths on every OS.** Bare names = PATH hijack as root.
- **Server-side `guacencPath` / `guacdPath` use the strict variant** (`*PathStrict()` → `null` when not at a canonical absolute path). The agent's `goPathStrict` mirrors the same rule. `/usr/local/bin` and `/opt/homebrew/bin` are operator-writable on common setups; a bare-name PATH search via `safeEnv()` would let a planted binary run as the service user.
- **Manifest-key rotation propagates via signed announcements.** `rotateUpdateManifestKey()` signs the new pubkey with the OLD private key before discarding it; the announcement (`{pubKey, sig, issuedAt}`) is stored in `settings.rmm.updateManifestRotationHistory` (cap 5) and shipped on every checkin. Agents verify under any pubkey in their persisted trust set and append the new key. Chain-of-trust survives per-agent HMAC compromise — substituting a manifest pubkey requires the previous Ed25519 private key, which the rotation flow discards.
- **Self-update smoke test runs with a minimal env.** `minimalSmokeEnv()` returns PATH (+ SYSTEMROOT on Windows) only. Pins the verification step against attacker-influenced env vars a future contributor might add (e.g. a systemd drop-in overriding the agent's runtime env).
- **RMM binary download pairs header + body to one file image.** `readAgentBinaryWithHash(os, arch, fd)` reads via the already-open O_NOFOLLOW fd and computes the hash from those same bytes; the `X-Binary-SHA256` / RFC 9530 `Content-Digest` headers can no longer disagree with the served stream during a concurrent rebuild.
- **Alert-rule auto-actions (`shell` / `script` / `service_action`) are fire-and-forget with NO `requireMfaStepUp` gate.** Intentional: the alert was authored with MFA at rule-create time; the cron evaluator fires without an operator. `filesystem_cleanup` is excluded from `alertActionSchema` (and from `dispatchCommandTypeEnum` via `.exclude(['filesystem_cleanup'])`) because that action requires a fresh second factor on every call. Tighten this only if you also tighten `agent_schedules` and bulk dispatch — same threat model.
- **Settings-credential AAD is `<path>:1`** (canonical `SETTINGS_CREDENTIAL_AADS`). Read + write + boot-time `repairLegacyEnc3SettingsAad` all share the map. Pre-fix migrations wrote the bare-label AAD; repair self-heals on next boot.
- **`/api/*` per-IP rate limit (600 req/min)** keyed by `event.getClientAddress()`. `assertProductionInvariants` rejects `ADDRESS_HEADER` paired with non-loopback `HOST` unless `TRUST_PROXY=true` explicitly opts in.
- **`/api/csp-report` CSRF-exempt + auth-exempt + body-capped (16 KiB) + rate-limited (60/min).** Writes only to log — no DB row, no reflection.
- **Error-reporter scrubs token-shaped secrets before egress.** `redactSensitiveInput` over message + stack frame filenames/functions + tag values before the Sentry envelope. Non-token operator data can still appear.
- **`users.role` defaults `'admin'`** on ALTER + INSERT-without-role. No code path provisions `'user'` today; `requireAdmin` is the future gate.
- **`SETTINGS_PATHS` in `scripts/rotate-session-secret.mjs` must include every settings credential.** Drop one and rotation silently drops the field. Enforced by `tests/unit/settings-paths-parity.test.ts` (reads `SETTINGS_CREDENTIAL_AADS` at runtime; asserts each label appears in the script's regex-scanned `SETTINGS_PATHS`).

## Upstream advisories

- `yauzl <3.2.1` (GHSA-gmq8-994r-jv83) via `puppeteer` — not used for user ZIPs.
- `cookie <0.7.0` (GHSA-pxg6-pf52-xh8x) forced to `^0.7.2` via `package.json#overrides` until SvelteKit's transitive bumps catch up.
