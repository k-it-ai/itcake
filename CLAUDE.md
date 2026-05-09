# ITCake

Single-user self-hosted web app: invoicing, tickets/time-tracking, uptime monitoring, RMM (Go agent), remote desktop (Apache Guacamole).

## Stack

SvelteKit (Svelte 5) + adapter-node, TypeScript, `better-sqlite3` (WAL), Tailwind v4, Vite 7, Node ≥ 20. Zod 4, bcryptjs + HMAC-SHA256 sessions, Nodemailer, Puppeteer, EJS, sanitize-html, dayjs, lean-qr, JSZip, guacamole-lite. Go agent in `agent/` (own `go.mod`, `CGO_ENABLED=0 -trimpath -buildvcs=false -ldflags='-s -w'`).

## Project structure

```
src/
  routes/
    (app)/                    Authenticated pages (dashboard, invoices, agents, settings, …).
                              Layout mounts v2 Sidebar + CommandPalette + global ⌘K listener.
    api/                      JSON endpoints — POST {action, ...} pattern via handleActionPost
      auth/                   login, logout, me, mfa, password, register
      agents/[id]/            commands, schedules, packages, services, events, remote-session
      rmm/                    checkin, enroll, download (bearer-only, CSRF-exempt)
      remote-desktop/         guacd install/update, recording playback
      backups/                local + offsite
    login/+page.server.ts     Form-action twin of /api/auth/login
    remote-desktop/[token]/   Popup that loads guacamole-common-js
  app.css                     v2 design tokens (port of itcake-redesign-v2.html :root) + legacy
                              v1 aliases that point at v2 vars so unmigrated pages still render.
  lib/
    server/                   DB, auth, totp, field-crypto, backup-crypto, changes (audit),
                              agent-auth, agent-build, request-utils, sanitize, pdf, …
    components/ui/            v2 design primitives: Tag · Dot · Btn · FilterChip ·
                              StatusPill · Bar · Spark · Avatar · Card · SectionHead · Toggle ·
                              EmptyState · ErrorState · Kbd
    components/shell/         v2 shell: Sidebar (228 px dark nav, cyan reserved for active) ·
                              TopBar (breadcrumb + title + sub + ⌘K trigger + right slot) ·
                              CommandPalette (mounted in (app)/+layout.svelte; ⌘K toggles)
    icons/index.ts            lucide-svelte re-exports — alias map covers v1 deprecated names
                              so call-sites can still import { Home, BarChart3, … }
    stores/                   theme.svelte.ts · nav.svelte.ts (sidebar groups + badge counts) ·
                              palette.svelte.ts (⌘K state, providers, results)
    i18n/                     en.ts, de.ts, server.ts (translateServiceError target)
    validators.ts             Web-side Zod schemas (login, settings, invoices, …)
    validators-rmm.ts         RMM Zod schemas (commands, schedules, alerts, agent profile)
  services/                   Business logic (auth-mfa, agents, agent-commands, agent-schedules,
                              backups, backup-offsite, guacamole, settings, emails, …)
  components/                 v1 form-context primitives still used inside forms/modals because
                              v2 doesn't ship Input/Select/TextArea/Modal/ConfirmDialog/Toast/
                              MoneyInput/RichTextArea/SearchInput/DataTable yet. Migrating just
                              v2 Btn into a form sea of v1 inputs causes padding/border mismatch,
                              so cohesion wins until v2 ships those primitives.
agent/                        Go RMM agent (own go.mod). cmd/agent main + run_unix/run_windows;
                              internal/{config,checkin,commands,packages,metrics,svclist,
                              eventlog,services}
tests/
  integration/lifecycle.test.ts   End-to-end: spawns vite dev, runs the full lifecycle
  unit/*.test.ts                  Vitest, no server boot, file-scope
assets/
  templates/                  Invoice/proposal EJS + master template
  templateStrings/{en,de}.json  PDF i18n
  design/handoff-v2/          v2 design spec (00-README, 01-design-tokens, 02-typography,
                              03-primitives, 04-shell, 05-pages, 06-status-system, 07-data-viz,
                              08-states, 09-a11y-motion, 10-svelte-map). v2 wins on visuals;
                              data + API + folder layout still come from /handoff/.
data/                         Runtime — itcake.db (WAL), uploads/, backups/, agent-binaries/, recordings/
```

## Design system (v2)

Tokens (`src/app.css`): surface (`--bg`/`--card`/`--ink`/`--muted`/`--line`/`--line-2`), brand (`--brand`/`--brand-2`/`--brand-ink`/`--brand-soft`), severity (`--good`/`--warn`/`--bad`/`--accent` + each `-soft`), sidebar (`--nav`/`--nav-active`/`--nav-active-text`/`--nav-mute`/`--nav-line`). Effects: `.shadow-card`, `.shadow-pop`, `.stripes`, `.stripes-brand`, `.skeleton`, `.num` (tabular figures).

Primitives are server-render-tested (`tests/unit/ui-primitives.test.ts` — 28 tests, beforeAll-hoisted compile so the cold lucide-svelte transform doesn't time out). When adding a primitive, add to that test's `PRIMITIVES` array.

Form-cohesion rule: pages render v2 primitives end-to-end. **Components that are themselves a form/modal (TicketForm, MonitorForm, EmailPreviewModal, LineItemEditor, DiscountEditor, ToInvoiceModal, UptimeSettingsForm, plus the settings page sub-sections that bind v1 Input/Select/TextArea) keep v1 Button/Toggle internally** so visual rhythm matches the surrounding inputs. Migrate them only once v2 ships Input/Select/TextArea/Modal.

Status system (`06-status-system.md`): `good` paid/online/pass · `warn` stale/near-due · `bad` overdue/offline/critical · `accent` recurring/scheduled/viewed · `brand` primary positive · `neutral` informational. Each tone has a soft fill paired with a hand-picked text colour. No other status colours allowed.

## Working with this codebase

- **Subagents:** dispatch with Opus or Sonnet only. Never Haiku — too dumb for security audits / refactors / cross-file reasoning. If a task is large enough that you'd consider Haiku for cost, ask the user first.
- **Tests are mandatory.** Every behavior change ships with a test in `tests/integration/lifecycle.test.ts` or `tests/unit/`. No exceptions.
- **Comments are off by default.** Bare-minimum critical only. Write one only if its absence would let a future change cause a real bug — a workaround for a known external library bug (cite version), a TS quirk that's fixable but obscure, a hidden constraint the type system can't express. NOT for "explaining the design", NOT for security rationale that's obvious from the code, NOT for "because X" prose. The why goes in the commit message; the function name + types are the documentation.

## Architecture invariants

Intentional for a single-user self-hosted app — don't swap for ORM / session library / Postgres. Flag bugs in the existing pattern, not the pattern.

- Raw prepared SQL against a JSON-in-SQLite document store. No ORM.
- Custom HMAC-SHA256 session tokens, single active session per user.
- Money: integer cents everywhere, never float. `computeInvoiceTotals` absorbs discount-rounding remainder into the largest tax group.
- Uptime + RMM use dedicated tables (time-series needs range queries).
- Two auth groups: bearer on `/api/rmm/*` (CSRF-exempt, JSON errors); cookie session everywhere else (CSRF-enforced). `/api/auth/*` pre-auth.

## Document store + mutation routing + i18n

`documents(id, type, data JSON, created_at, updated_at)`. Helpers in `db.ts`: `getDocument`, `getDocumentsByType` (10k cap), `insertDocument`, `updateDocument`, `deleteDocument`. Filter on `type` + `json_extract(data, '$.field')` with expression indexes. `custom_field_def` and `saved_filter` live in the same table for backup/restore parity + audit-log integration.

Two mutation paths — don't mix:
- **API routes** (`/api/*`) — `POST { action: 'update'|'delete', id?, ...data }` (default = create). Used by `fetch()`.
- **Form actions** (`?/name` on page servers) — status transitions, credit notes, convert-to-invoice. Used by `<form>`.

i18n (never hardcode user-facing strings):

| System | Files | Function |
| --- | --- | --- |
| UI | `src/lib/i18n/{en,de}.ts` | `t('key')` reactive store |
| Server errors | `src/lib/i18n/server.ts` | `serverT(lang)('key', { params })` |
| PDF templates | `assets/templateStrings/{en,de}.json` | `t('key')` in EJS |

Server errors: `throw new ServiceError('error.key', { detail })` (translated at API boundary via `translateServiceError`). `tests/unit/i18n-parity.test.ts` enforces key-set + placeholder parity for both UI and PDF strings.

Validator splits: `validators.ts` (billing core), `validators-auth.ts` (login/MFA/password/step-up), `validators-settings.ts`, `validators-rmm.ts`.

## Allowlists — update them all when adding a key/type/table

| Adding | Update |
| --- | --- |
| Settings key | `db.ts` `defaultSettings` + `lib/server/backup-allowlists.ts` `BACKUP_VALID_SETTINGS_KEYS` (one source consumed by `services/settings.ts`, `services/backups.ts`, `services/backup-verification.ts`) + section schema in `routes/api/settings/+server.ts` |
| Document type | `documents` table CHECK constraint + `lib/server/backup-allowlists.ts` `BACKUP_VALID_DOCUMENT_TYPES` + the rebuild block's CHECK + the `__type_check_*` probe loop |
| Audit log entity/action | `lib/server/changes.ts` `ChangeEntityType`/`ChangeAction` + `lib/server/backup-allowlists.ts` `BACKUP_VALID_ENTITY_TYPES`/`BACKUP_VALID_ACTIONS` + (if mapping needs an HTTP status) `request-utils.ts` `SERVICE_ERROR_STATUS` |
| Collector kind | `db.ts` `agent_collector_results.kind` CHECK + the rebuild block CHECK + `lib/types.ts` `CollectorResultKind` + `lib/server/collector-tables.ts` `COLLECTOR_TABLES` (so it shows up in `query_collector_results` / `list_collector_tables` AI tools) |
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

## Conventions (surprising / non-obvious only)

- All DB mutations in `db.transaction()`. Audit log via `recordChange()` inside the same transaction.
- API routes: `parseJsonBody()` (1 MiB cap) + Zod. `<Schema>.partial()` updates MUST go through `parseUpdateBody()` — Zod 4 partial keeps defaults, so a PATCH overwrites every absent field otherwise. Action-router routes dispatch via `handleActionPost` (auth + JSON parse + action allowlist + `ServiceError → HTTP`).
- LIKE search: escape `%`, `_`, `\` with `ESCAPE '\'`.
- CSRF: Origin/Referer in `hooks.server.ts`. `/api/rmm/*` exempt (bearer auth, JSON errors — agents parse JSON not HTML).
- File uploads: magic-byte verify, `O_NOFOLLOW`, `path.resolve` + `startsWith`, extension allowlist. SVG rejected.
- EJS: built-in trusted; custom sandboxed (allowlist + prototype-free + deep-frozen + JS-disabled Puppeteer + non-`data:` request interception). Logos baked to data URIs.
- SSRF: `resolveAndValidate()` covers IPv4 private/reserved + IPv6 loopback/link-local/ULA/mapped/NAT64/6to4/Teredo. Used by ping/HTTP/SSL/RDAP (per-redirect re-validation, max 5 hops). SMTP/S3/WebDAV pin the resolved IP via custom `lookup` agents.
- Monitor `ip` field rejects blocked ranges at create/update time (`rejectBlockedMonitorIp`) — not just at probe execution.
- Backup restore: explicit column mapping (`PRAGMA table_info`), rejects DBs with triggers/views, ticket descriptions re-sanitized, `mfa_step_up_used_codes` + `mfa_used_challenges` + `sessions` cleared.
- `processCommandResult(commandId, agentId, ...)` requires `agentId` — prevents cross-agent spoofing.
- Go agent shell-outs go through `syspath.*()` absolute paths on every OS (apt/dnf/pacman/apk/npm/pip/softwareupdate on Linux+macOS; choco/winget/scoop/powershell/cmd.exe/sc.exe on Windows). Bare-name fallbacks are PATH-hijack vectors as root.

## Encryption — what's encrypted where

All `enc3:` ciphertexts are AES-256-GCM via `field-crypto.ts` (HKDF + per-blob salt + AAD), keyed by scrypt-derived `SESSION_SECRET`. AAD binds the ciphertext to its identity — copying blob A into row B fails GCM-tag verification. Legacy `enc2:` blobs (no AAD) are still readable on first boot; `migrate*ToV3` re-wraps them with the right AAD. Unknown `encN:` prefix on read → fail-closed `''` with log.

| Surface | AAD / scheme |
| --- | --- |
| Session/bearer tokens, recovery code hashes, MFA-challenge nonces, step-up replay cache | HMAC-SHA256(`SESSION_SECRET`, …) — irreversible |
| Settings credentials | `enc3:` AAD `<path>:1` for: `emails.smtp.pass`, `uptime.telegram.botToken`, `ai.apiKey`, `backup.encryptionPassphrase`, `backup.offsite.s3.secretAccessKey`, `backup.offsite.webdav.password`, `rmm.updateManifestPrivateKey` |
| Per-row credentials | `enc3:` AAD `agent.hmacSecret:<id>`, `agent.remoteDesktop.{password,privateKey}:<id>`, `users.totpSecret:<id>` |
| Backup ZIP (optional) | AES-256-GCM via `backup-crypto.ts` (scrypt N=2¹⁷, v2 header). `.zip.enc`. Independent of `SESSION_SECRET`. Operator passphrase elided from the in-zip settings row so a leaked archive isn't self-decryptable |
| AI API key | Same as settings credentials. Masked `••••••••` in `GET /api/settings`; `***` POST preserves prior; strict-mode rejects plaintext-downgrade |
| Audit log | Per-row HMAC chain + `audit_anchor` HMAC + `audit_anchor_history` (per-snapshot HMAC keyed to `captured_at`) for tail-truncation forensics. `verifyAuditLogIntegrity()` reports `tamperedIds` and `anchor: ok|tail-truncated|mismatch|none` plus `historyTruncationDetected` |
| Agent config on disk | AES-GCM keyed by machine-id (Linux `/etc/machine-id`, macOS IOPlatformUUID, Windows MachineGuid). 0600 perms / Windows ACL. Defense-in-depth — NOT a boundary against local root |
| Self-update | Per-agent HMAC advisory `binary-advisory:agentId:hash:issuedAt` (mandatory) + optional Ed25519 manifest signature when `ITCAKE_UPDATE_MANIFEST_PUBKEYS` is set. `X-Binary-SHA256` + RFC 9530 `Content-Digest` cross-checked |

## Response headers

HSTS includes `preload` in prod. API JSON: `Cache-Control: no-store`. Plus `Cross-Origin-Resource-Policy: same-origin`, `X-DNS-Prefetch-Control: off`, expanded `Permissions-Policy`. CSP via SvelteKit nonce-based config (`svelte.config.js`) + `/api/*` fallback in `hooks.server.ts` — explicit `worker-src 'none'`, `manifest-src 'self'`, `media-src 'none'`, `frame-src 'self'`, `child-src 'self'`.

## AI brain

BYOK Anthropic-API assistant gated by server-side **risk tier** + **operator approval**. Disabled by default; enable + paste API key in Settings → AI.

**Tier resolution.** Direct `@anthropic-ai/sdk` Messages API + manual tool loop (no Agent SDK). `checkGuardrails(toolName, input, mode)` returns Tier 1..4 with action-level overrides (e.g. `dispatch_agent_command:shell` is Tier 3; `:system_info_refresh` is Tier 2). Unknown tool names AND unknown command actions fail-closed to Tier 4 reject. `TOOL_TIERS` is pinned by a parity test against `getRegisteredToolNames()`.

**Approval gate.** Tier 3 (and Tier 2 in `per_step` mode) inserts an `ai_tool_executions` row `status='pending'` and awaits an in-memory `Map<executionId, resolver>`. SSE emits `approval_required`; operator POSTs `/api/ai/sessions/:id/approvals`. 5-min reaper auto-rejects stale entries. On module load, `abortOrphanedPlans` expires both stale `plan_steps` rows AND stale `ai_tool_executions` rows so a process restart doesn't strand the operator on a forever-pending UI card.

**Tool result safety.** `compactToolResultForChat`: two-pass shrink (1.5KB/60/6-deep → 700/20/4 fallback) plus secret regex stripper covering Anthropic/OpenAI/GitHub/AWS/Slack/Stripe/Twilio/SendGrid/Azure-conn-string/GCP-svc-acct/JWT/PEM. `SCRIPT_BODY_FIELDS` (`scriptContent`/`command`/`payloadRaw`/etc.) over 200 chars omitted with placeholder. `redactSensitiveInput` recursively walks tool inputs before the SSE event AND the audit row.

**Input safety.** `sanitizeUserText` rejects 11 prompt-injection patterns + strips Unicode bidi / zero-width / U+2028/2029/180E. NFKC normalisation + Cyrillic/Greek homoglyph fold via `[-￿]` → lookup table so `іgnоrе previous instructions` is caught. 10 KiB per-input cap. `sanitizePageContext` recurses on every string field.

**Cost + turn cap.** `claimTurnSlotIfWithinBudget` is a single `db.transaction`: budget check + atomic `UPDATE ai_sessions SET turn_count = turn_count + 1 WHERE id = ? AND turn_count < ?`. Two concurrent POSTs to one session cannot both pass. 50 turns/session, 10-iteration tool loop, 16K `max_tokens`/turn. Per-message usage → `ai_cost_daily` (UTC), priced from a per-model table kept in sync with the `claude-api` skill. Default $50/month budget refuses new turns when `monthToDate >= limit`.

**Storage / audit.** `ai_sessions` + `ai_messages` (full transcript inc. tool_use/result blocks, resume-safe) + `ai_tool_executions` + `ai_cost_daily`. User-scoped — owner-only read/post. Session create + approval decisions go through the `changes` HMAC chain (`ai_session`, `ai_tool_execution`).

**Settings encryption.** `settings.ai.apiKey` `enc3:` AAD `ai.apiKey:1`. Masked `••••••••` in GET; `***` POST preserves prior; strict-mode rejects plaintext-downgrade. Model allowlist `{opus-4-7, opus-4-6, sonnet-4-6, haiku-4-5}` enforced by `aiSettingsSchema` so unknown models can't bypass cost-tracker pricing.

**Plan mode.** `propose_action_plan` lets the model propose ≤25 `{toolName, input, rationale}` steps; operator approves the whole plan once (with optional `editedSteps`). Subsequent calls auto-execute when they match the next step on tool name AND key fields (`agentId`/`action`/`scriptId`/`policyId`/`monitorId`/`ticketId`/`invoiceId`/`clientId`/`filename`). Per-action payload pinning via `DISPATCH_PINNED_KEYS_BY_ACTION` (shell→`command`, script→`scriptId/scriptContent/scriptName`, package_*→`package`, service_action→`service+action`, reboot→`delaySeconds+message`, filesystem_cleanup→`category+paths`). **`dispatch_agent_command` plan steps MUST pin `agentId` and `action`** — without that, "dispatch on agent a-1" would auto-approve any later destructive action. Plan timeout 10 min. State in `ai_sessions.plan_steps` + in-memory cache. SSE: `plan_proposed/approved/rejected/step_auto/deviation/completed`.

**`AI_REFUSED_ACTIONS`.** `dispatch_agent_command` MUST NOT carry `filesystem_cleanup` from the AI surface — that endpoint requires a per-call MFA step-up the AI can't provide. Hard-blocked at handler entry.

**API.** `POST /api/ai/sessions` (create), `GET /api/ai/sessions` (list), `GET /api/ai/sessions/:id`, `DELETE /api/ai/sessions/:id`, `POST /api/ai/sessions/:id/messages` (SSE stream), `POST /api/ai/sessions/:id/approvals`, `GET /api/ai/cost`.

**Adding a tool.** Create `src/lib/server/ai/tools/<domain>.ts`, call `registerTool(name, {definition, handler})`, add to `TOOL_TIERS` in `guardrails.ts`, import from `tools/index.ts`. The parity test in `ai-brain.test.ts` will flag a drift in either direction.

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

**Telemetry collectors** (each surfaces via `POST /api/agents/[id]/<feature> {action}`, snapshots stored in `agent_collector_results` keyed by `kind`, findings emitted to `agent_findings` with stable fingerprints for dedup):

- **Reliability** (`collect_reliability` → `kind=reliability_daily`, ≤90d). `computeScore` weights uptime 30 / crashes 25 / hangs 15 / serviceFailures 15 / hardwareErrors 15 → 0..100. `computeAggregateScore` returns latest score + 30d linear-regression trend (slope ±0.2 = up/flat/down, `confidence = r² × min(1, N/30)`) + 90d MTBF.
- **Peripheral inventory** (`peripheral_scan` → `kind=peripheral_inventory`). **Detection only.** Server `evaluateDevice(device, policy)` mirrors Go-side eval; server's verdict drives findings. Per-agent policy in `agents.data.peripheralPolicy` with vendor-only allowlists + time-limited exceptions.
- **Sensitive data scan** (`sensitive_data_scan` → findings `category=sensitive_data`). **Detection only.** Regex catalogue: SSN / email / PCI (Luhn-validated) / PHI / AWS keys / private keys / secret assignments / IBAN. NUL-byte binary skip; 64KiB chunks with 256-byte overlap so cross-chunk matches survive. SSN/PCI samples digit-masked.
- **Filesystem analysis + cleanup** (`filesystem_analysis` Tier 1 / `filesystem_cleanup` Tier 3). `filescan.Walk` via `workerpool` (default 4, max 16). Cleanup gated: absolute paths only, refuses post-`EvalSymlinks` resolution into `/etc /usr /bin /sbin /lib /boot /var/log /Applications /System C:\Windows C:\Program Files`, refuses owner-mismatch unless root/SYSTEM, refuses >1 GB. **Server requires fresh TOTP/recovery on every cleanup call when MFA is on** (`requireMfaStepUp`, replay-cache enforced). `AI_REFUSED_ACTIONS` blocks AI dispatch.
- **Network discovery + baseline** (`network_discovery` / `network_baseline_compare`). ARP read + ping/TCP-fallback + port scan + reverse DNS + compiled-in OUI table (top-200). Baseline drift findings: `new_device` (medium), `device_disappeared` (low, 24h), `device_changed` (low). **Operator confirms baseline manually** — auto-baseline would let a LAN attacker poison the trusted view.
- **Boot performance** (`boot_performance_collect`). Linux `systemd-analyze`, macOS `sysctl kern.boottime` + `log show`, Windows Diagnostics-Performance event 100. Dedups on `bootTimestamp`. Slow-boot finding low @ >90s, medium @ >180s.
- **Hardware warranty** (`hardware_warranty_collect`). SMBIOS via `/sys/class/dmi/id/*` (Linux), `system_profiler SPHardwareDataType -json` + AppleCare cache glob (macOS), `Get-CimInstance` (Windows). Operator override wins. Status `active|expiring|expired`. Findings low @ 90d, medium @ 30d, high once expired.
- **CIS hardening audit** (`cis_audit` → findings `category=policy`). **Detection only.** ~10 L1 checks per OS, CheckIDs match public CIS numbering. Engine has explicit `not_applicable` / `error` states.
- **Security posture aggregate** — server-only, 0..100 = `sensitive_data 25 + policy 20 + peripheral 15 + network 15 + filesystem 10 + reliability 15`. Severity-weighted slice deductions (critical=100% / high=80% / medium=50% / low=20%). Cached 5min, invalidated on finding state changes. `get_agent_security_posture` AI tool Tier 1.

**CSV / NDJSON exports.** `GET /api/exports?kind={agents,findings,audit}` (RFC 4180 + UTF-8 BOM, `Cache-Control: no-store`). `=`/`+`/`-`/`@`/`\t`/`\r` neutralised to prevent Excel formula injection. `GET /api/exports/osquery` ships osquery-shape NDJSON for SIEM ingestion (column names regex-validated at module load).

## MFA / TOTP

**Two-step login.** POST 1 (email+password) → `{ mfaRequired, mfaToken }` (5-min HMAC over `userId.expiresAt.nonce`, single-use via `mfa_used_challenges`). POST 2 (email+password+mfaToken+code) — **password re-verified on step 2** (otherwise the mfaToken is a bearer credential); **mfaToken consumed on the FIRST second-step attempt regardless of outcome** so a captured token isn't replayable for its 5-min TTL. TOTP secret `enc3:` AAD `users.totpSecret:<id>`; recovery codes HMAC-hashed, consumed via constant-time match + optimistic CAS. **Enable AND disable both require currentPassword** AND revoke all sessions in-transaction.

**Step-up replay cache.** Every `requireMfaStepUp`-gated endpoint (filesystem cleanup, backup delete/restore, manifest-key generate/rotate/remove, remote-session create, password change, MFA disable) burns the consumed TOTP into `mfa_step_up_used_codes` (HMAC-SHA256 keyed by `SESSION_SECRET`, 90s prune). Login also burns the TOTP it consumed — best-effort, never fails login on collision (login is single-use via `consumeMfaChallenge`); cache exists so a captured login TOTP can't be reused on a step-up surface within the OTP window. `requireMfaStepUp` rate-limited 10/15min per user (`mfa-stepup:<userId>`); bucket clears on successful step-up so legitimate maintenance bursts don't lock out.

**Order in /api/auth/password and /api/auth/mfa disable.** `currentPassword` verified BEFORE `requireMfaStepUp` so a session-only attacker can't probe TOTP validity without knowing the password.

## Backup

**Local.** ZIP via `services/backups.ts`. Restore validates allowlists, explicit column mapping per `PRAGMA table_info`, rejects DBs with triggers/views, re-sanitises ticket descriptions, clears `mfa_step_up_used_codes` + `mfa_used_challenges` + `sessions`.

**Encryption** (optional). `settings.backup.encryptionPassphrase` → AES-256-GCM (scrypt N=2¹⁷, v2 header; v1 still readable). `.zip.enc`. Passphrase ciphertext **elided from the in-zip settings row** so a leaked archive isn't self-decryptable. `getBackupPassphrase` throws `BackupPassphraseUnreadableError` instead of falling back to plaintext.

**Off-site.** S3-compatible (manual SigV4, no aws-sdk dep) or WebDAV. Schedule `daily|weekly|manual`. Credentials `enc3:`-encrypted; `***` masked in GET, `***` POST preserves. `POST /api/backups/offsite { test|run: true }`. Pinned-IP `lookup` agent on every connection.

**Verification ladder.** `verifyBackupIntegrity()` runs after each off-site upload (decrypt header → GCM tag → zip catalog → `PRAGMA integrity_check`). Weekly `runBackupTestRestore()` picks a candidate via `Math.floor(now/7d) % len`. `recomputeRecoveryReadiness()`: 30/25/25/20 pts (fresh local / integrity / test-restore <7d / off-site <24h), rebalanced when off-site disabled. Surfaced on dashboard.

## Remote desktop (Apache Guacamole, baked in)

ITCake supervises guacd (installed via the admin UI's OS package manager) and proxies WebSocket → guacd via guacamole-lite; browser uses guacamole-common-js.

**Lifecycle.** Operator clicks "Remote desktop" → `POST /api/agents/{id}/remote-session` (MFA-step-up gated) returns a one-time HMAC-hashed session token (5-min TTL). Browser opens `/remote-desktop/{token}` popup → WS `/api/remote-desktop/ws?token=…`. guacamole-lite validates, opens TCP to `guacd` (127.0.0.1:4822), forwards. On disconnect: `remote_sessions.ended_at` set; recording finalised.

**Hardening.**
- guacd binds 127.0.0.1 only.
- Session tokens single-use: `consumeRemoteSession` CAS on `consumed_at IS NULL` at popup load, `claimRemoteSessionStart` CAS on `started_at IS NULL` on WS open.
- Per-agent profile (`agents.data.remoteDesktop`) has the **operator-set host** (NEVER agent-reported `agent.ip`), port, username, password (`enc3:` AAD-bound), ignoreCert, domain, optional privateKey.
- Encrypted Guacamole token carries `{ connection: { type }, itcakeSessionId }` only — credentials resolved server-side at WS-open. Bit-flipping ciphertext at worst yields JSON-parse failure or sessionId mismatch.
- WS Origin validated on upgrade.
- `recording` (optional): `.guac` → MP4 via `guacenc` (`execFile`, no shell) on first playback. Refuses while `endedAt IS NULL`. Owner-only. Served as `attachment` to bypass strict `/api/*` CSP.
- Install/update: `POST /api/remote-desktop/guacd { action: install|update|status }`. Linux apt/dnf/pacman/apk; macOS brew. Windows unsupported upstream.

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

Load-bearing across multiple files. Changes here = security review, not refactor.

- **Agent HMAC secret AAD-bound per row** (`enc3:` AAD `agent.hmacSecret:<id>`). Cross-row blob copy fails GCM verification. Legacy empty `hmac_secret` → `signCommand` throws `LegacyEnrollmentError`; re-enrol.
- **Command `payloadRaw` verbatim on the wire.** `getPendingCommandsRaw()` returns exact DB bytes; agent re-HMACs them. Re-marshalling on either side breaks signature verification.
- **`--insecure` is enrollment-only, never persisted.** Pair with `--pin-tls` for capture-then-enforce.
- **Machine-bound config encryption is defense-in-depth, NOT a boundary against local root.** Windows ACL lockdown raises the bar for non-admin local users.
- **Encrypted Guacamole token carries no credentials.** Resolved server-side at WS-open via `processConnectionSettings(itcakeSessionId)`. Per-agent password/key AAD-bound. guacd host is operator-set, never `agent.ip` from the agent's own checkin.
- **Remote-desktop session tokens are bearer credentials, HMAC-SHA256-hashed at rest.**
- **Password change + MFA disable verify `currentPassword` BEFORE `requireMfaStepUp`** — closes the TOTP-validity oracle to a session-only attacker.
- **Recovery codes burned only after the surrounding flow commits.** `verifyMfaCode` is read-only; `consumeRecoveryCode` runs after the wrapping transaction succeeds.
- **SMTP / S3 / WebDAV / RDAP / HTTP / SSL / ping all DNS-rebind-pinned.** `pinnedLookup` resolves through `resolveAndValidate` per connection; `tls.servername` keeps SNI on the hostname while the socket dials the validated IP.
- **Backup encryption is not silently downgradable.** Configured-but-unreadable passphrase throws (`BackupPassphraseUnreadableError`); the passphrase ciphertext is elided from the in-zip settings row.
- **Audit anchor history HMAC keyed to `captured_at`** (matching the verifier). Old code reused the live anchor's HMAC keyed to `updated_at`, which silently failed verify outside a sub-millisecond timing window.
- **Go agent shell-outs go through `syspath.*()` absolute paths on every OS.** Bare names = PATH hijack as root.

## Upstream advisories (informational only)

- `yauzl <3.2.1` (GHSA-gmq8-994r-jv83) via `puppeteer` — not used for user ZIPs.

The `cookie <0.7.0` advisory (GHSA-pxg6-pf52-xh8x) is forced to `^0.7.2` via `package.json#overrides` until SvelteKit's transitive bumps catch up.
