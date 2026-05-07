# ITCake

Single-user self-hosted web app: invoicing, tickets/time-tracking, uptime monitoring, RMM (Go agent), remote desktop (Apache Guacamole).

## Stack

SvelteKit (Svelte 5) + adapter-node, TypeScript, `better-sqlite3` (WAL), Tailwind v4, Vite 7, Node ≥ 20. Zod 4, bcryptjs + HMAC-SHA256 sessions, Nodemailer, Puppeteer, EJS, sanitize-html, dayjs, lean-qr, JSZip, guacamole-lite. Go agent in `agent/` (own `go.mod`, `CGO_ENABLED=0 -trimpath -buildvcs=false -ldflags='-s -w'`).

## Project structure

```
src/
  routes/
    (app)/                    Authenticated pages (dashboard, invoices, agents, settings, …)
    api/                      JSON endpoints — POST {action, ...} pattern via handleActionPost
      auth/                   login, logout, me, mfa, password, register
      agents/[id]/            commands, schedules, packages, services, events, remote-session
      rmm/                    checkin, enroll, download (bearer-only, CSRF-exempt)
      remote-desktop/         guacd install/update, recording playback
      backups/                local + offsite
    login/+page.server.ts     Form-action twin of /api/auth/login
    remote-desktop/[token]/   Popup that loads guacamole-common-js
  lib/
    server/                   DB, auth, totp, field-crypto, backup-crypto, changes (audit),
                              agent-auth, agent-build, request-utils, sanitize, pdf, …
    i18n/                     en.ts, de.ts, server.ts (translateServiceError target)
    validators.ts             Web-side Zod schemas (login, settings, invoices, …)
    validators-rmm.ts         RMM Zod schemas (commands, schedules, alerts, agent profile)
  services/                   Business logic (auth-mfa, agents, agent-commands, agent-schedules,
                              backups, backup-offsite, guacamole, settings, emails, …)
  components/                 Svelte 5 components (ui/, agents/, invoices/, …)
agent/                        Go RMM agent (own go.mod). cmd/agent main + run_unix/run_windows;
                              internal/{config,checkin,commands,packages,metrics,svclist,
                              eventlog,services}
tests/
  integration/lifecycle.test.ts   End-to-end: spawns vite dev, runs the full lifecycle
  unit/*.test.ts                  Vitest, no server boot, file-scope
assets/
  templates/                  Invoice/proposal EJS + master template
  templateStrings/{en,de}.json  PDF i18n
data/                         Runtime — itcake.db (WAL), uploads/, backups/, agent-binaries/, recordings/
```

## Working with this codebase

- **Subagents:** dispatch with Opus or Sonnet only. Never Haiku — too dumb for security audits / refactors / cross-file reasoning. If a task is large enough that you'd consider Haiku for cost, ask the user first.
- **Tests are mandatory.** Every behavior change ships with a test in `tests/integration/lifecycle.test.ts` or `tests/unit/`. No exceptions.
- **Comments are off by default.** Bare-minimum critical only. Write one only if its absence would let a future change cause a real bug — a workaround for a known external library bug (cite version), a TS quirk that's fixable but obscure, a hidden constraint the type system can't express. NOT for "explaining the design", NOT for security rationale that's obvious from the code, NOT for "because X" prose. The why goes in the commit message; the function name + types are the documentation.

## Architecture invariants — align rather than replace

These are intentional for a single-user self-hosted app. Don't suggest swapping them for "industry-standard" alternatives (ORM, session library, Postgres) — at this scale they add complexity, dependencies, and attack surface for zero gain. Do still flag genuine bugs or security flaws in the existing pattern.

- Raw prepared SQL against a JSON-in-SQLite document store. No ORM.
- Custom HMAC-SHA256 session tokens, single active session per user (`createSessionTx` deletes all before inserting).
- Money: integer cents everywhere, never float. `computeInvoiceTotals` absorbs discount-rounding remainder into the largest tax group.
- Uptime + RMM use dedicated tables (not the document store) — time-series needs range queries.
- Two auth groups: bearer-only on `/api/rmm/*` (CSRF-exempt, JSON errors), cookie session on `/api/agents/*` and `/api/*` (CSRF-enforced). `/api/auth/*` pre-auth, `/api/config` GET only.

## Document store + mutation routing + i18n

`documents(id, type, data JSON, created_at, updated_at)`. Helpers in `db.ts`: `getDocument`, `getDocumentsByType` (10k cap), `insertDocument`, `updateDocument`, `deleteDocument`. Filter on `type` + `json_extract(data, '$.field')` with expression indexes.

Two document types are settings-shaped, not user-content: `custom_field_def` (per-installation extensions to per-entity field registries) and `saved_filter` (named filter for agents/invoices/tickets/etc.). They live in the same table because `documents` is the only at-rest store with backup/restore parity, audit-log integration, and JSON storage; the alternative would be three more tables that all need backup allowlist updates.

Two mutation paths — don't mix:
- **API routes** (`/api/*`) — `POST` with `action: 'update'|'delete'` (default = create). Used by `fetch()`. Pattern: `POST /api/{entity}` with `{ action, id?, ...data }`.
- **Form actions** (`?/name` on page servers) — status changes, credit notes, duplicate, convert-to-invoice. Used by `<form>`. Live in `routes/(app)/invoices/[id]/+page.server.ts` and `proposals/[id]/+page.server.ts`.

i18n — three systems, never hardcode user-facing strings:

| System | Files | Function |
| --- | --- | --- |
| UI | `src/lib/i18n/{en,de}.ts` | `t('key')` reactive store |
| Server errors | `src/lib/i18n/server.ts` | `serverT(lang)('key', { params })` |
| PDF templates | `assets/templateStrings/{en,de}.json` | `t('key')` in EJS |

Server errors → `throw new ServiceError('error.key', { detail })` (translated at API boundary via `translateServiceError`).

## Allowlists — update them all when adding a key/type/table

| Adding | Update |
| --- | --- |
| Settings key | `db.ts` `defaultSettings` + `lib/server/backup-allowlists.ts` `BACKUP_VALID_SETTINGS_KEYS` (one source consumed by `services/settings.ts`, `services/backups.ts`, `services/backup-verification.ts`) + section schema in `routes/api/settings/+server.ts` |
| Document type | `documents` table CHECK constraint + `lib/server/backup-allowlists.ts` `BACKUP_VALID_DOCUMENT_TYPES` + the rebuild block's CHECK + the `__type_check_*` probe loop |
| Audit log entity/action | `lib/server/changes.ts` `ChangeEntityType`/`ChangeAction` + `lib/server/backup-allowlists.ts` `BACKUP_VALID_ENTITY_TYPES`/`BACKUP_VALID_ACTIONS` + (if mapping needs an HTTP status) `request-utils.ts` `SERVICE_ERROR_STATUS` |
| RMM table | `replaceTables` in `restoreBackup()` |
| Alert action type | `validators-rmm.ts` `alertActionSchema` discriminated union + `services/alerts.ts` `runAlertActions` switch + `lib/types.ts` `AlertAction` union |
| Agent command type | `validators-rmm.ts` `commandTypeEnum` + `validators-rmm.ts` `scheduleTypeEnum` (if cron-schedulable) + `db.ts` `agent_commands` CHECK + the rebuild block CHECK + `agent_schedules` CHECK + the rebuild block CHECK + `lib/types.ts` `AgentCommandType` + Go agent `checkin.go` dispatch switch |
| Finding category / collector kind | `db.ts` `agent_findings.category` CHECK + `agent_collector_results.kind` CHECK + `lib/types.ts` `FindingCategory` / `CollectorResultKind` |
| Numbered entity | seed counter in `db.ts` (keys: `invoice_global`, `proposal_global`, `client_global`, `ticket_global`, `agent_global`) |

Settings deep-merge protected against prototype pollution (`__proto__`, `constructor`, `prototype`, `__defineGetter__`, etc.).

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

## Conventions

Surprising / non-obvious only. The rest is in the code.

- All DB mutations in `db.transaction()`. Audit log via `recordChange()` inside the same transaction.
- API routes: `parseJsonBody()` (1 MiB cap) + Zod. Update endpoints with a `<Schema>.partial()` MUST go through `parseUpdateBody(schema, input)` — Zod 4's `partial()` keeps `.default()` values, so a PATCH of `{notes:'x'}` would otherwise overwrite every other field with its schema default. Action-router routes (`/api/{units,catalog-items,clients,monitors,tickets,invoices,proposals,agents/*}`) dispatch via `handleActionPost` which centralises auth, JSON parsing, the action allowlist, and `ServiceError → HTTP` translation.
- LIKE search escapes `%`, `_`, `\` with `ESCAPE '\'`.
- CSRF: Origin/Referer in `hooks.server.ts` for state-changing requests. RMM agent endpoints exempt (bearer auth) and return `json({error}, {status})` — never `throw error()` (agents parse JSON, not HTML).
- File uploads: magic-byte verification, `O_NOFOLLOW`, `path.resolve` + `startsWith`, extension allowlist. SVG rejected at type-check.
- EJS: built-in trusted; custom sandboxed (allowlist + prototype-free + deep-frozen + JS disabled in Puppeteer); option keys `/^[a-zA-Z][a-zA-Z0-9_]*$/`. PDF: Puppeteer with JS disabled + request interception blocking non-`data:` URLs. Logos converted to data: URIs in template-context.
- DNS-pinned SSRF protection via `resolveAndValidate()` — covers IPv4 private/reserved, IPv6 loopback/link-local/ULA/mapped/NAT64/6to4/Teredo. Used by ping/HTTP/SSL/RDAP (each redirect re-validated; max 5 hops). SMTP transport pins the resolved IP via a custom `lookup` agent so DNS rebinding can't slip past.
- Backup restore: explicit column mapping via `PRAGMA table_info`; rejects DBs with triggers/views; ticket descriptions re-sanitized.
- `processCommandResult(commandId, agentId, ...)` requires `agentId` — prevents cross-agent spoofing.

## Encryption — what's encrypted where

| Surface | Mechanism | Notes |
| --- | --- | --- |
| Bearer/session tokens, TOTP recovery codes, MFA-challenge nonces | HMAC-SHA256 keyed by `SESSION_SECRET` | irreversible |
| SMTP pass, Telegram bot token, S3/WebDAV creds, backup passphrase | AES-256-GCM, `field-crypto.ts` `enc2:` (HKDF + per-blob salt) | keyed by `SESSION_SECRET` (scrypt-derived). Unknown `encN:` prefix on read → fail-closed `''` with log line. Calls supplying AAD with an `enc2:` blob fail-closed too — silent AAD bypass would defeat the row-binding promise of v3 |
| Agent HMAC secret, per-agent remote-desktop password / private-key, user TOTP secret, RMM update-manifest signing key | AES-256-GCM, `field-crypto.ts` `enc3:` (AAD-bound) | row-bound: copying agent A's blob to agent B's row fails GCM-tag verification. v2 ciphertexts auto-migrate to v3 on next write. AAD format: `agent.hmacSecret:<id>`, `agent.remoteDesktop.{password,privateKey}:<id>`, `users.totpSecret:<id>`, `rmm.updateManifestPrivateKey:1` (singleton — the `:1` anchors AAD to one fixed identity) |
| Backup ZIP (optional) | AES-256-GCM, `backup-crypto.ts` (scrypt N=2¹⁷, v2 header) | `.zip.enc`. Independent of `SESSION_SECRET`. Operator-supplied passphrase, NOT stored in the in-zip settings row (elided at backup time so the artifact isn't self-decryptable) |
| Anthropic API key | AES-256-GCM, `field-crypto.ts` `enc3:` AAD `ai.apiKey:1` | `settings.ai.apiKey`. Strict-mode rejects plaintext-downgrade |
| Audit log integrity | HMAC-SHA256 chain (`changes.hash`) + HMAC-anchored `audit_anchor` row | `verifyAuditLogIntegrity()` returns `tamperedIds` AND `anchor: 'ok'`/`'tail-truncated'`/`'mismatch'`/`'none'`. The anchor blocks tail-truncation that the chain alone misses |
| Agent config + replay cache on disk | AES-GCM keyed by machine-id (config) / mode-0o600 + Windows ACL (cache) | defense-in-depth, NOT a boundary against local root |
| Self-update binary hash | per-agent HMAC over `binary-advisory:agentId:hash:issuedAt` | agent verifies before download. Without it, a CA-trusted MITM could substitute hash + binary with valid TLS |
| Binary integrity | `X-Binary-SHA256` + RFC 9530 `Content-Digest` header | agent cross-checks |

## Response headers

HSTS includes `preload` in prod. API JSON: `Cache-Control: no-store`. Plus `Cross-Origin-Resource-Policy: same-origin`, `X-DNS-Prefetch-Control: off`, expanded `Permissions-Policy`. CSP via SvelteKit nonce-based config (`svelte.config.js`) + `/api/*` fallback in `hooks.server.ts` — explicit `worker-src 'none'`, `manifest-src 'self'`, `media-src 'none'`, `frame-src 'self'`, `child-src 'self'`.

## AI brain

BYOK Anthropic-API assistant gated by a server-side **risk tier** + **operator approval** model. Disabled by default; enable + paste an Anthropic API key in Settings → AI to use.

**Architecture.** No Anthropic Agent SDK — direct `@anthropic-ai/sdk` Messages API with manual tool loop. The model proposes a tool call; server-side `checkGuardrails(toolName, input, mode)` resolves the tier (1..4), with action-level overrides (e.g. `dispatch_agent_command:shell` is Tier 3, `dispatch_agent_command:system_info_refresh` is Tier 2). Unknown tool names and unknown command actions fail-closed to Tier 4 reject — the model can never execute by inventing a name.

**Approval gate.** Tier 3 (and Tier 2 in `per_step` mode) inserts an `ai_tool_executions` row with `status='pending'` and awaits via an in-memory `Map<executionId, resolver>` — no Redis, no DB poll. The session's SSE stream emits `approval_required`; the operator POSTs the decision to `/api/ai/sessions/:id/approvals`, which writes the audit row + resolves the in-process Promise. 5-min reaper auto-rejects stale entries.

**Tool result safety.** Every tool result goes through `compactToolResultForChat`: two-pass shrink (1.5KB strings / 60-array / 6-deep, fallback 700/20/20/4) plus bare-secret regex stripper that catches `sk-ant-…`, `sk-…` (OpenAI), `ghp_/ghs_/gho_/ghu_…`, `AKIA…`, `xoxb/xoxp…`, JWTs, PEM private keys. Long script bodies (`scriptContent`, `command`, etc.) over 200 chars are omitted with a placeholder.

**Input safety.** `sanitizeUserText` rejects 11 prompt-injection patterns (`ignore previous instructions`, `act as DAN`, `<|im_start|>`, etc.) and strips Unicode bidi/zero-width characters. 10 KiB per-input cap. `sanitizePageContext` runs the same on every string field of the page-context payload.

**Cost tracking.** Per-message usage is recorded into `ai_cost_daily` (one row per UTC day) with cost computed at row-insert time using a per-model price table (kept in sync with the `claude-api` skill). Monthly budget guard refuses new turns when `monthToDateCostCents >= settings.ai.monthlyBudgetCents`. Default $50/month.

**Model defaults.** `claude-opus-4-7` with `thinking: {type: 'adaptive'}` and `effort: 'high'`. Operator can override in Settings → AI. Streaming + 16K `max_tokens` per turn, 50 turns per session, 10-iteration tool loop cap.

**Storage.** `ai_sessions` (per-chat metadata + cumulative usage), `ai_messages` (full transcript including tool_use/tool_result blocks for resume), `ai_tool_executions` (audit trail), `ai_cost_daily` (cost roll-up). Sessions are user-scoped; only the owner can read or post.

**Audit log.** Session create + tool-execution approval decisions go through the existing `changes` HMAC chain (entity types `ai_session`, `ai_tool_execution`).

**API.** `POST /api/ai/sessions` (create), `GET /api/ai/sessions` (list), `GET /api/ai/sessions/:id` (detail + transcript), `DELETE /api/ai/sessions/:id` (close), `POST /api/ai/sessions/:id/messages` (post + SSE stream the reply), `POST /api/ai/sessions/:id/approvals` `{action: 'decide', executionId, decision}`, `GET /api/ai/cost`.

**Settings encryption.** `settings.ai.apiKey` field-encrypted via `enc3:` with AAD `ai.apiKey:1`. Strict-mode rejection of plaintext-downgrade (same as SMTP/Telegram credentials).

**Plan mode.** Approval mode `plan` enables the `propose_action_plan` tool — the model proposes a multi-step plan up front (max 25 steps, each `{toolName, input, rationale}`); the operator approves the *whole plan once* via the existing `/api/ai/sessions/:id/approvals` endpoint (with optional `editedSteps` to tweak before approving). Subsequent tool calls that match the next planned step (tool name AND key fields `agentId`/`action`/`scriptId`/`policyId`/`monitorId`/`ticketId`/`invoiceId`/`clientId`/`filename`) auto-execute without per-step approval; deviations emit `plan_deviation` SSE and fall back to per-step approval. **`dispatch_agent_command` plan steps MUST pin both `agentId` and `action`** at propose-time — the matcher is permissive about plan-undefined fields (so the model can refine), and `action` is what determines the risk tier; without that constraint a plan saying "dispatch on agent a-1" would auto-approve any later destructive call. The check is enforced in `propose_action_plan`'s handler. Plan timeout 10 min (vs per-step 5). Plan state persisted in `ai_sessions.plan_steps` JSON; in-process `plan-mode.ts` cache mirrors it for the hot path. SSE events: `plan_proposed`, `plan_approved`, `plan_rejected`, `plan_step_auto`, `plan_deviation`, `plan_completed`.

**Adding a tool.** Create `src/lib/server/ai/tools/<domain>.ts`, call `registerTool(name, {definition, handler})`. Add the tool name to `TOOL_TIERS` in `guardrails.ts`. Import the new file from `tools/index.ts`. Done.

## RMM

Privileged service: LaunchDaemon / systemd / SCM (LocalSystem / root).

**Enrollment.** Operator generates 15-min single-use token → agent generates 32-byte hex `hmacSecret` via `crypto/rand` → posts `{token, hostname, os, arch, hmacSecret}`. Server stores `hmacSecret` AES-GCM under `SESSION_SECRET` (`enc3:`, AAD-bound to the agent id) and bearer token as HMAC-SHA256 hash. Agent's local config is AES-GCM under a machine-id-derived key (Linux `/etc/machine-id`, macOS IOPlatformUUID, Windows MachineGuid). Optional `--pin-tls` captures leaf SPKI; `--insecure` is enrollment-only, never persisted.

**Command dispatch.** `{ id, agentId, type, payload, payloadRaw, signature, issuedAt, timeoutSeconds }`. Signature = HMAC over `id:agentId:type:payloadRaw:issuedAt` keyed by per-agent secret. Agent verifies: agentId match, signature, ±10 min replay window, persistent replay cache (`replay-cache.json` next to config; survives restart). `payloadRaw` is verbatim DB bytes — re-serializing breaks signature verification.

**Privilege.** macOS `Execute()` drops to the console user via `sudo -u` so brew/npm/pip find that user's profile. Linux `Execute()` runs as the service identity (root under systemd); `packages.ConsoleUser` consults `$SUDO_USER` only for brew/npm/pip command-string construction. `ExecuteAsRoot()` for `/Applications` removal / OS updates / reboot. Windows: `cmd.exe /d /s /c` + `CREATE_NO_WINDOW`, already root, no scoop in SYSTEM context.

**Self-update.** Server emits `binaryHash` plus a per-agent HMAC advisory (`binary-advisory:agentId:hash:issuedAt`) in every checkin. Agent verifies advisory (±10 min skew), downloads over pinned TLS, verifies SHA-256 + RFC 9530 `Content-Digest` header, runs the new binary's `version` subcommand as smoke test, atomic rename, exits for service manager to restart. Pre-flight `checkBinaryPathWritable` probes the install dir before downloading so a `ProtectSystem=strict` systemd unit aborts cleanly instead of after a 50 MB fetch. On Linux/macOS the live binary is `os.Remove`'d before the rename so a same-inode mmap'd text segment doesn't trip ETXTBSY on filesystems that complain about rename-over-running-exec.

Optional **Ed25519 manifest signature** (additive — keeps the existing HMAC advisory intact). Server stores a per-instance Ed25519 keypair in `settings.rmm.updateManifestPrivateKey` (encrypted via field-crypto with `enc3:` AAD `rmm.updateManifestPrivateKey:1`). When configured, every checkin response includes `binaryManifestSignature = ed25519(privKey, "binary-manifest:<agentId>:<binaryHash>:<issuedAt>")`. Agents that have at least one base64 raw 32-byte public key in `ITCAKE_UPDATE_MANIFEST_PUBKEYS` (comma-separated) require the signature to verify before downloading; with no pubkeys configured, the field is ignored (backward compat). Generate / rotate / remove the keypair via `POST /api/agents/update-manifest-key { action: 'generate'|'rotate'|'remove'|'status' }` (cookie-authenticated; CSRF-protected like every other `/api/agents/*` route — the `/api/rmm/*` carve-out is bearer-only). Bypassing the HMAC advisory now also requires forging an Ed25519 signature, so a CA-trusted MITM with the per-agent HMAC secret still can't substitute the binary on agents that have the pubkey deployed.

**Status:** `online` → `stale` (2× threshold) → `offline` (3× threshold). Settings (`validators-rmm.ts`): `defaultCheckinInterval` 60s (10–3600), `staleThresholdMinutes` 5 (1–60), `metricsRetentionHours` 48 (1–720), `commandTimeoutSeconds` 300 (5–3600).

**Transport caps.** TLS 1.2+ enforced client-side; response 1 MiB; error 4 KiB; jitter ±10%; checkin payload caps stdout 1 MiB / stderr 256 KiB / packages 10k / services 1k.

**AV-friendliness.** No UPX/packers; `-trimpath -buildvcs=false`; Windows VERSIONINFO + manifest via `go generate ./cmd/agent`; metrics via Win32 APIs only at runtime (no WMI/PowerShell).

**Files:**

| OS | Binary | Config (AES-GCM) | Service | Log |
| --- | --- | --- | --- | --- |
| macOS | `/usr/local/bin/itcake-agent` | `/Library/Application Support/ITCake/agent-config.json` 0600 | `/Library/LaunchDaemons/com.itcake.agent.plist` | `/var/log/itcake-agent.log` |
| Linux | `/usr/local/bin/itcake-agent` | `/etc/itcake-agent/config.json` 0600 | `/etc/systemd/system/itcake-agent.service` | journald |
| Windows | `C:\ProgramData\ITCake\itcake-agent.exe` | `C:\ProgramData\ITCake\agent-config.json` (icacls SYSTEM+Admins only) | SCM `ITCakeAgent` (auto + recovery 5s/30s/2m) | Event Log + stdout to SCM |

Windows file modes are silently ignored by Go — `lockdownPath` in `agent/internal/config/acl_windows.go` shells out to `icacls.exe` to set SYSTEM + Administrators only.

**Features.** Scheduled scripts (5-field cron, UTC; `dispatchCommand` with same HMAC pipeline; per-type payload validation runs at both schema and service layer). Event log collection (level≥warning, journalctl/`log show`/wevtutil, once per 10 check-ins). Software inventory delta (per-manager snapshot diff → `agent_events`). Alert rules (`metric_threshold` / `agent_offline` / `agent_reboot_required` / `monitor_status`, per-rule cooldown via `last_fired_at`). Tags + bulk dispatch (`agents.tags` JSON; `[a-z0-9_-]` ≤50 chars, ≤30 tags; each match gets its own HMAC). Reboot (`{ delaySeconds 0..86400, message }`; `shutdown -r +<min>` / `shutdown.exe /r /t <sec> /f`).

**Reliability scoring.** Daily-bucket model: `collect_reliability` runs `reliability.Collect()` on the agent (journalctl/`log show`/wevtutil + uptime probe), emits `{day, uptimeSeconds, crashes, hangs, serviceFailures, hardwareErrors}` as JSON in `commandResult.stdout`. Server detects the command type and stores the payload in `agent_collector_results` with `kind='reliability_daily'` (≤90d retention). `computeScore` weights uptime 30 / crashes 25 / hangs 15 / serviceFailures 15 / hardwareErrors 15 → 0..100. `computeAggregateScore` returns the latest day's score plus a 30-day trend (linear regression on daily scores; slope ±0.2 marks the up/flat/down threshold; `confidence = r² × min(1, N/30)`) and a 90-day MTBF (uptimeHours / total failures, `null` when failures = 0). `GET /api/agents/[id]/reliability` exposes the aggregate.

**Peripheral inventory.** **Detection only — no kernel driver, no OS-level blocking.** `peripheral_scan` runs `peripheral.Enumerate()` on the agent (Linux: `/sys/bus/usb/devices/` + udev fallback for class; macOS: `system_profiler SPUSBDataType -json`; Windows: `wmic Win32_PnPEntity` with `Get-PnpDevice` fallback) and emits `{devices, policyVersion}`. Server applies `evaluateDevice(device, policy)` (pure, mirrors `EvaluateDevice` in Go — both sides eval, server's verdict drives findings) and walks the result: `block`/`alert`/`read_only` actions become `agent_findings` rows (severity from action; fingerprint over vendorId+productId+serialNumber+busType+deviceClass), the entire inventory snapshot becomes a `peripheral_inventory` collector result. Per-agent policy lives in `agents.data.peripheralPolicy`: `{deviceClass: 'storage'|'all_usb'|'bluetooth'|'thunderbolt', action: 'allow'|'block'|'read_only'|'alert', exceptions: [{vendor?, product?, serialNumber?, allow, expiresAt?}]}`. Exception model is the operator value-add — vendor-only allowlists, time-limited overrides, case-insensitive matching. `POST /api/agents/[id]/peripheral` `{action: 'set-policy', policy}` or `{action: 'scan'}`; `GET` returns latest inventory + open findings.

**Sensitive data scan.** **Detection only — no encrypt/quarantine/secure-delete.** `sensitive_data_scan` runs `secscan.Scan(scope)` on the agent over operator-specified paths. Regex catalogue (`agent/internal/secscan/patterns.go`): `pii_ssn`/`pii_email`/`pci_card_number` (+ Luhn validation)/`phi_medical_reference`/`credential_aws_access_key`/`credential_private_key`/`credential_secret_assignment`/`financial_iban`. Bounded by `scope.timeoutSeconds` (5..1800), files capped at `scope.maxFileSizeBytes` (1KB..100MB, default 5MB), `scope.workers` (1..16, default 4) goroutines, binary files skipped via NUL-byte heuristic in first 8KB, scanner reads in 64KiB chunks with 256-byte boundary overlap so a credit-card number split across chunks still matches (`idx[1] <= minStart` = entirely-in-tail = skip; spanning matches survive). Sample masked digit-by-digit for SSN/PCI before reporting; truncated to 64 chars by the server. Each finding becomes an `agent_findings` row with `category='sensitive_data'`, `fingerprint = sha256(category + path + patternId + line)` so re-scans dedup. `POST /api/agents/[id]/sensitive-data` `{action: 'scan', scope}` validates via `validateScanScope` (Zod); `GET` returns findings list. Operator marks findings `accepted`/`false_positive` via the existing finding-state UI.

**Filesystem analysis + cleanup.** Two-stage: `filesystem_analysis` (read-only, AI Tier 1) + `filesystem_cleanup` (mutating, AI Tier 3). `filescan.Walk(scope)` chunks the FS via `agent/internal/workerpool` (default 4 workers, max 16), bounded by `scope.timeoutSeconds` (1..3600, default 600). Categorises by path-glob + age threshold: `temp_files`, `browser_cache`, `package_cache`, `trash`, `old_downloads` (>90d), `unrotated_logs` (>30d, >100MB). Top-N min-heap tracks largest files (50) + dirs (30) without holding the full tree in memory. Resumable via `<configDir>/filescan-checkpoint.json` (60s flush) so a long scan survives restart. **Cleanup is gated**: `cleanup.go` requires absolute paths, refuses anything resolving (post `EvalSymlinks`) into `/etc /usr /bin /sbin /lib /boot /var/log /Applications /System C:\Windows C:\Program Files`, refuses owner-mismatch unless agent runs as root/SYSTEM, refuses files > 1 GB. Server-side `filesystem_cleanup` API requires a fresh TOTP / recovery code on every request when MFA is enabled (re-verified per call, not per-window). Findings emitted on category `totalBytes > 5 GB` (severity low). `POST /api/agents/[id]/filesystem` `{action: 'scan'|'cleanup', ...}`; `GET` returns latest analysis + open findings.

**Network discovery + baseline.** `network_discovery` runs `netdisc.Scan(opts)` on the agent: subnet auto-detect from local interfaces (skip loopback/link-local/PtP), ARP-table read (Linux `/proc/net/arp`, mac/Win shell), ICMP ping with TCP-connect fallback (no x/net/icmp dep added — only used if already in go.sum), TCP port scan against operator-supplied top-N ports (default 22/80/443/445/3389/5900/8080/etc), `net.LookupAddr` for hostname. Compiled-in OUI prefix table (top-200 vendors) for vendor lookup. Concurrency-bounded (default 32). Result: `[{ip, mac, hostname, openPorts[], vendor, lastSeen}]` stored in `agent_collector_results` `kind='network_discovery'`. **Baseline drift**: separate `network_baseline_compare` command compares the latest scan against the stored baseline (`kind='network_baseline'`) and emits findings: `new_device` (severity medium, fingerprint `(agentId, ip, mac)`), `device_disappeared` (low, after 24h absent), `device_changed` (low, hostname/vendor mismatch). Operator confirms baseline via `POST /api/agents/[id]/network` `{action: 'set-baseline'}` — automatic baseline updates are deliberately avoided so an attacker who joins your LAN can't trivially poison the trusted view.

**Boot performance.** `boot_performance_collect` runs `bootperf.Collect()` on the agent, server stores in `agent_collector_results` `kind='boot_performance'`. Linux: `systemd-analyze` (handles European decimal locale + the firmware/loader/userspace phases — userspace mapped to `desktopReadySeconds`). macOS: `sysctl -n kern.boottime` + `log show --predicate 'process == "loginwindow"' --last boot` first event (BIOS/loader stay 0 — platform doesn't expose them). Windows: `Get-WinEvent -FilterHashtable @{LogName='Microsoft-Windows-Diagnostics-Performance/Operational'; Id=100} -MaxEvents 1` parsing `BootTime`/`MainPathBootTime`/`BootPostBootTime`; bios derived as `bootTime - mainPath - postBoot` if positive. Server dedups by `bootTimestamp` so re-running on the same boot session is a no-op. Slow-boot threshold (>90s) emits a low-severity `policy` finding (medium >180s). `POST /api/agents/[id]/boot-performance` `{action: 'collect'}`; `GET` returns trend with median + p95.

**Hardware warranty.** `hardware_warranty_collect` reads SMBIOS identity. Linux: `/sys/class/dmi/id/{sys_vendor,product_name,product_serial,bios_version,bios_date,chassis_type}` directly (root needed for product_serial — service runs as root). macOS: `system_profiler SPHardwareDataType -json` + a glob over `/Users/*/Library/Application Support/com.apple.NewDeviceOutreach/caches/coverageDetails/<serial>.json` for AppleCare data (parses `settingsCoverageSection.offer.expiration` Unix timestamp or `coverageExpirationLabel` `Expires January 2, 2006` regex). Windows: one `Get-CimInstance Win32_BIOS + Win32_ComputerSystem + Win32_SystemEnclosure` call. Server stores latest snapshot in `agent_collector_results` `kind='hardware_warranty'`; operator override (`agents.data.warrantyOverride.warrantyEndDate`) wins over agent-detected date. Status is computed: `active` / `expiring` (≤90d) / `expired`. Findings: low @ 90d, medium @ 30d, high once expired. `POST /api/agents/[id]/warranty` `{action: 'collect'|'set-override', warrantyEndDate?, purchaseDate?, notes?}`. No vendor API integration (Dell/HP/Lenovo) — operator inputs expiry manually for non-Apple hosts.

**CIS hardening audit.** **Detection only — no remediation.** `cis_audit` runs `cis.RunBenchmark()` against ~10 CIS Benchmark L1 checks per OS (cramfs disabled, ASLR=2, IP forwarding off, firewall active, SSH PermitRootLogin=no on Linux; FileVault, Gatekeeper, SIP, app firewall, screen-saver password on macOS; password policy ≥14, Guest disabled, all firewall profiles enabled, Audit Credential Validation, LocalAccountTokenFilterPolicy on Windows). CheckIDs match the public CIS numbering so external auditors can cross-reference. Engine has explicit `not_applicable` and `error` states (a missing `sshd_config` on a desktop ≠ failing the check). Each `fail` becomes one `agent_findings` `category='policy'` row, severity from the catalogue, fingerprint `(cis, agentId, checkId)` so re-runs dedup and reappearances flip resolved → open. Snapshot stored in `agent_collector_results` `kind='cis_audit'`. `POST /api/agents/[id]/cis` `{action: 'audit'}`; `GET` returns latest + 30-audit history.

**Security posture aggregate score.** Server-only — composes existing inputs. 0..100 per-agent meta-score = `sensitive_data 25 + policy 20 + peripheral 15 + network 15 + filesystem 10 + reliability 15`. Each finding-category slice is deducted by severity (critical=100% / high=80% / medium=50% / low=20% of slice); reliability is the latest day's score scaled to its 15-pt allotment. Cached 5min; cache invalidated on finding state changes. `GET /api/agents/[id]/posture` + `get_agent_security_posture` AI tool (Tier 1) + a card on the agent overview tab. Differs from Breeze's posture (encryption + AV + firewall + ports + password policy + OS currency + admin exposure + patch compliance) — itcake doesn't yet collect those telemetry inputs in a structured way, so we use what we have.

**CSV exports.** `GET /api/exports?kind={agents,findings,audit}` produces RFC 4180 CSV with the Excel-friendly UTF-8 BOM. Findings export honours `?category=` and `?state=`; audit honours `?entityType=` and `?entityId=`. Filename sanitised to `[a-zA-Z0-9._-]`; `Cache-Control: no-store`. Quotes anything containing comma/quote/CR/LF or leading/trailing space; serialises objects/arrays as JSON, dates as ISO. Subtle "Export CSV" links on the agents list, the findings tab, and Settings → Audit integrity. No new deps.

## MFA / TOTP

Two-step login. POST 1 = email+password → if MFA on, returns `{ mfaRequired, mfaToken }` (5-min HMAC over `userId.expiresAt.nonce`, single-use server-tracked via `mfa_used_challenges`). POST 2 = email+password+token+TOTP/recovery code; **password is re-verified on the second step** (otherwise the mfaToken would be a bearer credential). TOTP secret AES-GCM at rest (`enc3:` AAD `users.totpSecret:<id>`); recovery codes HMAC-SHA256 hashed, consumed via constant-time match + optimistic-CAS update on `users.totp_recovery_hashes`. Recovery code is consumed AFTER `consumeMfaChallenge` succeeds so a parallel-tab race doesn't burn it for the legitimate user. Disable requires password + TOTP/recovery. Password change requires TOTP/recovery when MFA is enabled. Both enable and disable revoke all of the user's active sessions inside the same DB transaction.

## Backup

**Local + downloads.** ZIP via `services/backups.ts`. Restore validates allowlists; explicit column mapping when schemas differ.

**Encryption.** `settings.backup.encryptionPassphrase` wraps the ZIP with AES-256-GCM (scrypt N=2¹⁷, v2 header; v1 N=2¹⁵ still readable). Saved as `.zip.enc`. The configured passphrase ciphertext is **elided from the in-zip settings row** so a leaked `.zip.enc` requires the operator-typed passphrase, not just `SESSION_SECRET`. `getBackupPassphrase` reads the raw row + decrypts explicitly + throws `BackupPassphraseUnreadableError` rather than silently falling back to plaintext.

**Off-site upload** (admin-configurable). `settings.backup.offsite`. Targets: S3-compatible (manual SigV4, no aws-sdk dep) or WebDAV. Schedule `daily | weekly | manual`. 24 h tick checks `lastUpload.at` against cadence (server-set only — schema strips client-supplied `lastUpload`). Credentials encrypted; `***` masked in API responses; submitting `***` preserves prior. `POST /api/backups/offsite` `{ test: true }` or `{ run: true }`.

**Verification ladder.** Two tables: `backup_verifications` (id, filename, type=`integrity`|`restore`, status, sizeBytes, durationMs, details JSON) and `recovery_readiness` (single row id=1: 0..100 score + risk factors + last successful timestamps). After every successful off-site upload `verifyBackupIntegrity()` runs (decrypt header → GCM tag → zip catalog → `PRAGMA integrity_check` against extracted DB). Once a week the 24h tick picks a candidate via `Math.floor(now / 7d) % len` and runs a full `runBackupTestRestore()` (extract + integrity_check + same allowlist sanity restoreBackup() applies). `recomputeRecoveryReadiness()` aggregates: 30 pts fresh local backup, 25 pts integrity passed, 25 pts test-restore < 7d, 20 pts off-site < 24h (rebalanced if off-site disabled). Surfaced on dashboard. `POST /api/backups/verification` `{action: 'verify-integrity'|'test-restore'|'recompute', filename?}`. **Why it exists:** itcake's external-monitoring runbook says "have something else watch ITCake," but until this ladder existed nothing watched the backups themselves.

## Remote desktop (Apache Guacamole, baked in)

ITCake spawns and supervises **guacd** (install via OS package manager from the admin UI; updates via the same path) and proxies WebSocket → guacd via **guacamole-lite**. Browser embeds **guacamole-common-js**.

**Connection lifecycle:**
1. Operator clicks "Remote desktop" on agent detail → `POST /api/agents/{id}/remote-session` returns a one-time HMAC-signed **session token** (5-min TTL, hash-only stored in `remote_sessions`).
2. Browser opens a popup at `/remote-desktop/{token}` which loads guacamole-common-js and connects WebSocket `/api/remote-desktop/ws?token=<token>` (single-use).
3. guacamole-lite validates the token, opens TCP to `guacd` (127.0.0.1:4822 by default), forwards the Guacamole protocol.
4. On disconnect, `remote_sessions.ended_at` is set (`markRemoteSessionEnded`); recording (if enabled) is finalised.

**Hardening.**
- guacd binds 127.0.0.1 only.
- Session tokens are short-lived, single-use, consumed on first WebSocket upgrade. `processConnectionSettings` rejects when `started_at` is already set (one-shot).
- Per-agent connection profile (`agents.data.remoteDesktop`): protocol, **operator-set host** (NOT agent-reported IP — agents can fake it), port, username, password (`enc3:` AAD-bound), ignoreCert, domain, optional privateKey.
- Encrypted Guacamole token carries no credentials. It contains only `{ connection: { type }, itcakeSessionId }`. Hostname/port/username/password/recording-path are resolved server-side via `processConnectionSettings` at WS-open time, keyed on the already-validated `itcakeSessionId`. Bit-flipping the AES-256-CBC ciphertext can at worst produce JSON-parse failure or a sessionId-mismatch — never a credential leak or host redirection.
- WebSocket Origin validated on upgrade — same protection as REST CSRF.
- Audit log via the existing `changes` chain: entity type `remote_session`, actions `create` / `connect` / `disconnect`.
- Optional session **recording** — guacd writes `.guac` files to `DATA_DIR/recordings/<session-id>/`. Playback via `GET /api/remote-desktop/recording/<sessionId>` lazily transcodes to MP4 with `guacenc` on first access (refuses while `endedAt IS NULL` so an in-progress session isn't corrupted). MP4 served as `attachment` to bypass the strict `/api/*` CSP. Owner-only.
- Install/update from official source — `POST /api/remote-desktop/guacd` `{ action: 'install'|'update'|'status' }`. Linux: apt/dnf/pacman/apk; macOS: brew. Windows is unsupported by upstream.

## Operator runbook

| Task | Steps |
| --- | --- |
| Revoke a compromised agent | `POST /api/agents` `{ action: 'delete', id }`. Invalidates bearer + HMAC instantly. Audit-logged. |
| Rotate a compromised SESSION_SECRET | Stop service → set new value → start. Loses: audit-log hash chain (every pre-rotation row surfaces as `tampered`; the anchor reports `mismatch`), all sessions, all field-encrypted values, TOTP recovery hashes. After restart: re-enter SMTP + Telegram, re-pair MFA + regenerate recovery codes, re-enroll all agents, re-enter backup credentials, re-enter per-agent remote-desktop passwords. Plan a maintenance window. |
| Restore from backup | UI → Backups → Restore. If `.zip.enc`, the original passphrase must be entered. Backup contains current SESSION_SECRET-derived ciphertexts — restore on a different host without the same SESSION_SECRET makes encrypted fields unrecoverable. |
| Enable off-site backup | Settings → Backup → enable, choose S3 or WebDAV, fill creds, "Test connection", set schedule. Secrets stored encrypted; UI shows only `***`. |
| Set a backup passphrase | Settings → Backup → enter passphrase. New ZIPs become `.zip.enc`. Old `.zip` backups stay readable. Changing the passphrase locks out previously-encrypted backups — keep the old one until those are rotated out. |
| Install/update Guacamole | Settings → Remote Desktop → "Install guacd" / "Update". Runs OS package manager. After install, supervisor binds 127.0.0.1:4822. `/api/remote-desktop/guacd` `{ action: 'status' }` reports state on demand; no automatic background health-check tick. |
| Audit-log integrity check | `GET /api/changes/integrity` returns `{ total, verified, unverified, tamperedIds, anchor }`. Pre-migration rows show `unverified`. Pre-rotation rows show `tampered`. `anchor: 'tail-truncated'` or `'mismatch'` is a real incident unless preceded by a documented SESSION_SECRET rotation. |
| External monitoring | ITCake monitors others; have something else monitor ITCake. Point pingdom / uptimerobot / ohdear at `/api/health`. |

## Background tasks (`hooks.server.ts`, all `setInterval(...).unref()`)

- 60 s — uptime checks · RMM stale detection · command expiry · cron-schedule dispatch · alert evaluation · expired remote-desktop session-token cleanup
- 60 min — session cleanup · recurring invoices · overdue marking
- 1 h — RMM auto-update tick (per-agent interval)
- 24 h — prune audit log >1y · uptime daily aggregation/prune · RMM metrics prune · agent-events prune · off-site backup tick

Overlap guards on `runChecks` / `runDailyChecks`.

## Security model invariants

Cross-cutting, load-bearing across multiple files. Treat changes here as a security review, not a refactor.

- **Agent HMAC secret per-device, AES-GCM-encrypted at rest, logically verbatim** — derived neither from `SESSION_SECRET` nor hashed (HMAC needs the key recoverable). `enc3:` ciphertext with AAD `agent.hmacSecret:<agentId>` so a DB writer who copies one agent's encrypted secret into another agent's row sees GCM tag verification fail. Legacy pre-migration agents (empty `hmac_secret`) cannot have commands dispatched: `signCommand` throws `LegacyEnrollmentError`. Re-enroll the agent.
- **Command `payloadRaw` verbatim on the wire** — `getPendingCommandsRaw()` preserves exact DB bytes; the agent recomputes HMAC over those bytes. Re-marshalling on either side breaks signature verification.
- **`--insecure` is enrollment-only and never persisted.** Pair with `--pin-tls` to capture-then-enforce a self-signed cert.
- **Machine-bound config encryption is defense-in-depth, NOT a boundary against local root.** On Windows the ACL lockdown raises the bar for non-admin local users (file inherits SYSTEM+Admins from the locked-down parent dir).
- **Encrypted Guacamole token carries no credentials.** Sensitive details resolve server-side via `processConnectionSettings` at WS-open time, keyed on `itcakeSessionId`. Per-agent password/key are AAD-bound (`enc3:`). The guacd target host is operator-set (`agents.data.remoteDesktop.host`), never `agent.ip` from the agent's own checkin.
- **Remote-desktop session tokens are bearer credentials, stored only as HMAC-SHA256 hashes.** Distinct from the support-ticket entity (`documents.type='ticket'`).
- **Password change requires the second factor when MFA is enabled.** `POST /api/auth/password` rejects with 403 when `users.totp_enabled = 1` and no `mfaCode`. Login JSON path also re-verifies the password on the mfaToken branch.
- **Recovery codes burned only after the surrounding flow commits.** `verifyMfaCode` returns `'totp'`/`'recovery'`/`null` without side effects; `consumeRecoveryCode` runs after `consumeMfaChallenge` / `disableMfaTx` / `changePassword` succeeds.
- **SMTP DNS-rebind protection.** `pinnedLookup` resolves through `resolveAndValidate` per connection; `tls.servername` keeps SNI on the hostname while the socket dials the validated IP.
- **Backup encryption is not silently downgradable.** Configured-but-unreadable passphrase throws instead of writing plaintext; the passphrase ciphertext is elided from the in-zip settings row.

## Upstream advisories (informational only)

- `yauzl <3.2.1` (GHSA-gmq8-994r-jv83) via `puppeteer` — not used for user ZIPs.

The `cookie <0.7.0` advisory (GHSA-pxg6-pf52-xh8x) is forced to `^0.7.2` via `package.json#overrides` until SvelteKit's transitive bumps catch up.
