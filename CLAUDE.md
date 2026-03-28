# ITCake

Single-user self-hosted web invoicing app with ticketing, time tracking, uptime monitoring, and RMM (Remote Monitoring & Management).

## Features

```
Tickets
├── Auto-numbered     T-001, T-002, etc. (counter in `counters` table)
├── CRUD              Client, date/time, hours, hourly rate, rich description
├── Status            open ↔ completed → invoiced (dropdown on badge, invoiced is terminal)
├── Time tracking     Start time + hours, calendar view (day/3-day/week, scrollable)
├── To Invoice        Convert to new invoice or append to existing draft/sent invoice
│   └── Line item     "IT-Support am DD.MM.YYYY" (DE) / "IT-Support on YYYY-MM-DD" (EN)
│   └── Unit          "Std." (DE) / "hrs" (EN)
├── Calendar          CSS Grid, 15-min slots, 20px/slot, color-coded (amber/green/blue)
├── Summary           Weekly/monthly hours + earnings cards
├── Sanitization      Description HTML sanitized server-side via sanitize-html on write
└── QuickCreate       "+New Ticket" in top nav quick-create menu

Invoicing
├── Invoices          CRUD, nested line items, net/gross pricing, discounts
│   ├── Status        draft → sent → paid | overdue (auto) | cancelled
│   ├── Credit notes  Created from sent invoice, linked, negated amounts
│   ├── Recurring     Cron-like auto-generation, skip missed dates
│   ├── PDF           Puppeteer render from EJS templates
│   ├── Email         Send via SMTP with per-type email templates
│   ├── Export        ZIP of selected invoice PDFs
│   └── SEPA QR       EPC QR code on invoices for direct bank payment
├── Proposals         Same item/pricing model as invoices
│   ├── Status        draft → sent → accepted | rejected | expired
│   └── Convert       sent → creates invoice, marks proposal accepted
├── Clients           CRUD, auto-numbered (C-001), mandatory email + address, VAT, contact
├── Expenses          CRUD, receipt uploads (JPG/PNG/WebP/PDF), categories
├── Catalog items     Reusable line item presets (name, price, unit, tax)
├── Units             Custom measurement units
├── Templates         Single built-in (kossov-it), replaceable via Settings; custom EJS via API
│   ├── Sandbox       Custom templates: only <%= %> allowed, CSS url() data:-only
│   └── Preview       Settings shows thumbnail + overlay preview; export/replace via JSON
├── Reports           Revenue + tax breakdown by year/month
├── Dashboard         Monthly revenue chart, summary stats (SQL aggregation, no full-table scan)
├── Audit log         All mutations tracked, 1-year retention, auto-pruned
├── Backup/restore    ZIP (SQLite + uploads), validation before restore, preview
├── Global search     Cross-entity (invoices, proposals, clients, tickets, expenses)
├── Pagination        Server-side for invoices, proposals, clients (URL-driven filters, SQL LIMIT/OFFSET)
└── Settings          Company, documents, template, emails, advanced, password, backups
    └── Kleinunternehmer   §19 UStG small business VAT exemption (zeroes tax rates)

Uptime monitoring
├── Check types       ping (execFile), HTTP (fetch), SSL expiry (tls), domain expiry (RDAP)
├── History           Granular checks (48h TTL) → daily aggregates (forever)
├── Notifications     Telegram + email, 24h cooldown on expiry alerts
├── SSE events        Real-time status updates to dashboard
└── SSRF protection   DNS-resolved private IP rejection on all outbound checks

RMM (Remote Monitoring & Management)
├── Go agent          Static binary, macOS + Linux, HTTPS polling (30s default)
├── Enrollment        Time-limited tokens (15min, single-use), one-liner install+enroll+service command
│   ├── macOS         Downloads, signs (xattr+codesign), installs to /usr/local/bin, enrolls, starts LaunchDaemon
│   ├── Duplicate     Re-enrolling same hostname+os+arch replaces old agent automatically
│   └── Uninstall     `sudo itcake-agent uninstall` removes service, binary, config, logs, receipts
├── Auth              Bearer tokens (HMAC-SHA256 hashed), CSRF-exempt /api/rmm/ endpoints
├── Metrics           CPU (model: M1/M4/etc.), RAM, disk (APFS-aware via diskutil), load (1/5/15), uptime
│   └── Storage       48h granular → daily aggregates (kept forever), same 2-tier pattern as monitors
├── Commands          Shell exec as console user (not root), collapsible output, duplicate prevention
│   └── Privilege     Shell commands drop to console user by default (brew/npm refuse root).
│                     `sudo` prefix or package ops use ExecuteAsRoot when needed
├── Packages          5 sources, AppCleaner-style deep uninstall
│   ├── apps          macOS /Applications/*.app bundles (excludes brew casks to avoid duplicates)
│   │   └── Uninstall Removes .app + ~/Library (as user) + /Library + receipts + LaunchAgents/Daemons
│   ├── brew          Formulae + casks (GUI apps). Runs as console user. Uninstall uses --zap
│   ├── apt/dnf/      Linux package managers — run as root
│   │   pacman/apk
│   └── npm/pip       Run as console user
├── Services          macOS: launchctl + /Library/Launch{Daemons,Agents}. Linux: systemd
├── SSE events        Real-time status on check-in + command dispatch
├── Stale detection   Online → stale (2min) → offline (6min)
├── IP detection      Agent reports LAN IP (UDP probe to 1.1.1.1), not server-side getClientAddress
└── Distribution      Auto-builds + serves binaries at /api/rmm/download/:os/:arch (requires Go on server)

UI / cross-cutting
├── i18n              UI: en, de (t() function) — Templates: en, de (templateStrings)
├── Theme             Dark / light toggle
├── Auth              bcryptjs + HMAC-SHA256 sessions, setup wizard, rate-limited login
└── Billing math      Integer cents, tax group accumulation, discount proportional allocation
```

## Stack

SvelteKit (Svelte 5) + adapter-node, TypeScript, SQLite/better-sqlite3 (WAL),
Tailwind CSS v4, Vite 7, Node >= 20. Zod validation, bcryptjs + HMAC-SHA256
session tokens, Nodemailer SMTP, Puppeteer PDF, EJS templating, sanitize-html,
dayjs, lean-qr (SEPA EPC), JSZip (backup export/restore).

## Architecture (do not suggest alternatives)

- Raw prepared SQL against JSON-in-SQLite document store — no ORM by design
- Custom HMAC-SHA256 session tokens (not a session library) — by design
- Single-user app — single session per user is intentional
- Test suite: vitest (unit + integration). Run `npm test`
- **Testing rule**: Every new feature or behavioral change MUST include a corresponding test in the integration test suite (`tests/integration/lifecycle.test.ts`) or a unit test. The test must verify the feature works end-to-end, including edge cases and error paths. No feature is complete until its test passes.
- Uptime monitoring uses dedicated tables (not the document store) — time-series data needs efficient range queries
- Monitors: hybrid storage — `enabled`/`status` in columns, config in JSON `data` blob. Each monitor has separate `ip` and `domain` fields (not a single `target`). Ping prefers IP, HTTP prefers domain, expiry checks require domain.
- Two-tier history: `monitor_checks` (granular, 48h TTL) → `monitor_daily` (aggregated, kept forever)
- RMM agents use dedicated tables (same pattern as monitors) — `agents`, `agent_metrics`, `agent_metrics_daily`, `agent_commands`, `agent_services`, `agent_packages`
- Agent auth is bearer token (separate from cookie sessions) — agents aren't browsers, so CSRF and cookies don't apply
- Agent-facing API (`/api/rmm/*`) returns JSON errors (not SvelteKit HTML), CSRF-exempt, bearer token auth; UI-facing API (`/api/agents/*`) uses standard cookie auth
- Go agent is a separate module in `agent/` — cross-compiled with `CGO_ENABLED=0` for static binaries
- Agent runs as LaunchDaemon (macOS) / systemd (Linux) = root. Shell commands drop to console user by default (detected via `/dev/console` owner on macOS). Package uninstall for `apps` source uses `ExecuteAsRoot`. Brew commands always run as console user (brew refuses root).
- macOS apps from `/Applications` are listed as `apps` source, excluding brew casks (which appear under `brew` source). Uninstall path differs: brew uses `--zap`, apps use AppCleaner-style script (bundle ID + app name search across ~/Library, /Library, /var/db/receipts)
- Agent detail page tabs persist in URL (`?tab=packages`), survives page reload
- QuickCreate menu is icon-only with tooltips (horizontal bar, no text labels)

## Directory Layout

```
src/
  routes/           SvelteKit pages + API routes
    (app)/           Authenticated app pages (layout requires login)
      tickets/       Ticket/time-tracking dashboard
      uptime/        Uptime monitoring dashboard
      agents/        RMM agent management
    api/             JSON API endpoints
      tickets/       Ticket CRUD + status + convert-to-invoice APIs
      monitors/      Monitor CRUD + history APIs
      agents/        Agent CRUD, commands, packages, services, enrollment, SSE
      rmm/           Agent-facing: enrollment, check-in, binary download (bearer auth)
      uptime/        Notification settings + Telegram test APIs
    login/           Login page (form action)
    setup/           First-run setup wizard (form action)
  components/
    ui/              Reusable UI primitives (Button, Input, Modal, Toggle, etc.)
    forms/           Form-specific components (LineItemEditor, etc.)
    layout/          Sidebar, TopBar, GlobalSearch
    invoice/         Invoice-specific display components
    tickets/         Ticket components (TicketCard, TicketForm, ToInvoiceModal, TicketCalendar)
    uptime/          Uptime monitoring components (UptimeBar, UptimeChart, MonitorCard, MonitorForm, UptimeSettingsForm)
    agents/          RMM components (AgentCard, AgentTerminal, AgentMetricsChart, AgentPackageList, AgentServiceList, EnrollmentDialog)
  lib/
    server/          Server-only: auth, db, pdf, email, rate-limit, sanitize, template rendering, service-error (ServiceError class)
      checks/        Uptime check implementations (ping, http, ssl, rdap) + target validation
    i18n/            Translation files (en, de)
    stores/          Svelte stores (theme)
    money.ts         Billing math (cents-based, integer arithmetic)
    validators.ts    Zod schemas for all entities
    types.ts         TypeScript interfaces
  services/          Business logic layer (invoices, proposals, clients, tickets, monitors, agents, etc.)
assets/
  templates/         EJS invoice/proposal templates + master template
  templateStrings/   Per-language translation JSON for templates (en, de)
tests/
  unit/              Unit tests (billing math, validators, etc.)
  integration/       Integration tests (services, DB operations)
agent/               Go agent module (separate go.mod)
  cmd/agent/         CLI entry point (enroll, run, service, version)
  internal/          Agent internals (config, checkin, metrics, commands, packages, services)
  build/             Makefile for cross-compilation (4 targets)
data/                Runtime: SQLite DB, uploads, backups, agent-binaries (gitignored)
```

## Document Store

`documents` table: `id TEXT PK, type TEXT, data TEXT (JSON), created_at, updated_at`.
All entity data lives in the `data` JSON blob. Services use helpers from `db.ts`:
`getDocument`, `getDocumentsByType` (safety-limited to 10,000 rows), `insertDocument`, `updateDocument`, `deleteDocument`.
Queries filter on `type` column + `json_extract(data, '$.field')` with expression indexes.

## Mutation Routing

Two mutation paths — don't mix them up:

- **API routes** (`/api/*`): CRUD for all entities. Action-based POST: `action: 'update'|'delete'` (default=create). Used by client-side `fetch()`.
- **Form actions** (`?/actionName` on page servers): Status changes, credit notes, duplicate, convert-to-invoice. Used by SvelteKit `<form>` submissions. Located in `routes/(app)/invoices/[id]/+page.server.ts` and `routes/(app)/proposals/[id]/+page.server.ts`.

Key form actions: `?/status`, `?/creditNote`, `?/duplicate`, `?/convertToInvoice`, `?/update` (save form), `?/delete`.

## PDF Pipeline

`template-context.ts` (builds EJS context: helpers, seller/buyer, totals, `t()`)
→ `template-renderer.ts` (EJS render; `_master/template.ejs` wraps body template + CSS)
→ `pdf.ts` (Puppeteer with request interception: blocks all non-`data:` URLs).
Logos are converted to `data:` URIs in template-context. External URLs do not work in templates.
Semaphore limits concurrent pages to 4. Mutex on browser launch.

## i18n — Two Systems

| System | Files | Scope | Function |
|--------|-------|-------|----------|
| UI i18n | `src/lib/i18n/{en,de}.ts` | App interface | `t('key')` reactive Svelte store |
| Server i18n | `src/lib/i18n/server.ts` | Service errors, background tasks | `serverT(lang)('key', { params })` |
| Template strings | `assets/templateStrings/{en,de}.json` | PDF/invoice rendering | `t('key')` in EJS via `getTemplateStrings(lang)` |

UI labels → add to `en.ts` + `de.ts`. PDF labels → add to both JSON files in `templateStrings/`.
Server-side user-facing errors → use `ServiceError('error.key')` (translated at API boundary via `translateServiceError`). Error i18n keys use the `error.*` prefix in `en.ts`/`de.ts`.

## Counters and ID Formats

`counters` table: `key TEXT PK, value INTEGER`. Keys: `invoice_global`, `proposal_global`, `client_global`, `ticket_global`.
`incrementCounterWithMin(key, minValue)` atomically increments (respects `nextNumber` from settings).
`resolveIdFormat(format, number)` turns `{YYYY}-{####}` + counter into `2026-0001`.
Settings control format strings and `nextNumber`. Adding a new numbered entity → seed counter in `db.ts`.

## Settings

Defaults seeded in `db.ts`. `getSetting(key)` falls back to defaults. `updateSettingsSection(key, value, userId?)` deep-merges.

**When adding a new setting key**, update all three:
1. `db.ts` — default value in `defaultSettings`
2. `services/settings.ts` — `VALID_SETTINGS_KEYS` set
3. `services/backups.ts` — `VALID_SETTINGS_KEYS` in `validateBackupData()`

## Backup Validation Allowlists

`backups.ts` `validateBackupData()` has hardcoded sets that **must** be updated when adding features:
- `VALID_TYPES` — document types (invoice, proposal, client, ticket, ...)
- `VALID_SETTINGS_KEYS` — settings keys (general, company, invoices, proposals, emails, advanced, uptime, rmm)
- `VALID_ENTITY_TYPES` — audit log entity types (invoice, monitor, ticket, agent, ...)
- `VALID_ACTIONS` — audit log actions (create, update, delete, status_change, reopen, send_email)
- `BUILT_IN_TEMPLATE_IDS` — built-in template names (currently only `kossov-it`)

Forgetting these causes backup restore to reject valid backups silently.

Backup restore also includes RMM tables (`agents`, `agent_metrics`, `agent_metrics_daily`, `agent_commands`, `agent_services`, `agent_packages`, `agent_enrollment_tokens`). When adding new RMM tables, add them to `replaceTables` in `restoreBackup()`.

## Database Tables

- `users`, `sessions` — auth
- `documents` — JSON-in-SQLite document store (invoices, proposals, clients, units, catalog items, templates, expenses, tickets)
- `settings` — key-value config store (general, company, invoices, proposals, emails, advanced, uptime)
- `changes` — audit log (entity_type, entity_id, action, diff JSON, user_id)
- `counters` — auto-increment sequences (invoice_global, proposal_global, client_global, ticket_global)
- `monitors` — uptime monitors (id, data JSON, enabled, status, timestamps)
- `monitor_checks` — individual check results (auto-pruned to 48h)
- `monitor_daily` — daily aggregates per monitor per check type (kept indefinitely)
- `rate_limits` — SQLite-backed rate limiting (login, setup, email sending)
- `agents` — RMM agent registration (id, name, hostname, os/arch, token_hash, status, data JSON)
- `agent_enrollment_tokens` — one-time enrollment tokens (15min TTL, single-use)
- `agent_metrics` — granular metrics (CPU/RAM/disk/load, 48h TTL)
- `agent_metrics_daily` — daily aggregated metrics (kept forever)
- `agent_commands` — command queue + history (shell, package ops, service actions)
- `agent_services` — service inventory per agent (upserted on check-in)
- `agent_packages` — package inventory per agent (upserted on check-in)

## Environment Variables

| Variable | Default | Purpose |
|----------|---------|---------|
| `DATABASE_PATH` | `data/itcake.db` | SQLite database file path |
| `DATA_DIR` | `data` | Runtime data (uploads, backups) |
| `HOST` | `127.0.0.1` | Bind address |
| `PORT` | `3000` | Listen port |
| `ORIGIN` | — | Public URL (required in prod for CSRF) |
| `NODE_ENV` | — | `production` enables secure cookies + enforces `SESSION_SECRET` |
| `SESSION_SECRET` | — | HMAC key for session tokens + at-rest encryption key (required in prod) |
| `PUPPETEER_NO_SANDBOX` | `false` | `true` for Docker/root (disables Chromium sandbox) |
| `ADDRESS_HEADER` | — | Header for real client IP behind reverse proxy (e.g. `X-Forwarded-For`). Required for rate limiting to work behind Caddy/nginx. |

SMTP configured in-app via Settings, not env vars.

## Commands

```sh
npm run dev        # Start dev server
npm run build      # Production build (adapter-node)
npm run preview    # Preview production build
npm run start      # Run production (node build/index.js)
npm run check      # svelte-kit sync + svelte-check
npm run test       # Run vitest (unit + integration)
npm run test:watch # Run vitest in watch mode
npm run build:agent     # Build Go agent for current platform (requires Go)
npm run build:agent:all # Cross-compile agent for all 4 targets (requires Go)
```

## Conventions

- **NEVER hardcode user-facing strings.** All text must go through `t('key')` (UI) or `getTemplateStrings(lang)` (server-side/PDF). This includes error messages, notification text (email/Telegram), button labels, tooltips, status labels, and any string a user might see. Add keys to BOTH `en.ts` and `de.ts`. Server-side code that cannot access the reactive `t()` store (e.g., background tasks, notifications) should use the language from `getSetting('general').language` and look up strings from the i18n dictionaries directly.
- Money in integer cents everywhere (10000 = €100.00). Never float for money.
- Discount rounding reconciliation: when discounts span multiple tax groups, per-group rounding can diverge by 1-2 cents. `computeInvoiceTotals` adjusts the largest group to absorb the remainder (standard accounting rounding allocation).
- Template option keys: restricted to valid identifiers (`/^[a-zA-Z][a-zA-Z0-9_]*$/`) to prevent `__proto__`/`constructor` injection via Zod schema.
- All DB mutations wrapped in `db.transaction()`. Audit log via `recordChange()`.
- Status transitions validated via `validateTransition<S>(map, current, target, label)` in `document-helpers.ts`. Adding a new entity with a status machine → define a `VALID_TRANSITIONS` map and call this generic helper.
- API routes use `parseJsonBody()` (streaming, size-limited) + Zod validation. LIKE search filters must escape `%`, `_`, `\` with `ESCAPE '\'` — see `getInvoicesPaginated` for the pattern.
- CSRF: Origin/Referer check in hooks.server.ts for all state-changing requests.
- File uploads: magic byte verification, path traversal guards, extension allowlists.
- EJS templates: custom templates sandboxed (allowlist + prototype-free context + deep-freeze). Built-in templates are trusted.
- Settings deep-merged with prototype pollution protection (BANNED_KEYS).
- Uptime checks: DNS-pinned SSRF protection — `resolveAndValidate()` returns validated IP, used directly by ping/HTTP/SSL checks to prevent DNS rebinding. Covers IPv4 private/reserved, IPv6 loopback/link-local/ULA, IPv6-mapped IPv4, NAT64, 6to4 (2002::/16), and Teredo (2001:0000::/32) with embedded IPv4 extraction and re-check.
- Session tokens: constant-time comparison via `crypto.timingSafeEqual` (fetches all active sessions, compares in JS).
- At-rest encryption: `smtp.pass` and `telegram.botToken` encrypted with AES-256-GCM (key from `SESSION_SECRET`) in the settings table. `getSetting` decrypts on read; `setSetting` encrypts on write. Startup migration encrypts existing plaintext and batch-migrates v1 (`enc:`) values to v2 (`enc2:`) format. No-op without `SESSION_SECRET` (dev mode).
- Backup encryption: same `encryptField`/`decryptField` — backup creation checks for both `enc:` and `enc2:` prefixes before encrypting; restore copies encrypted values as-is (no decrypt step; `getSetting` handles it transparently).
- Uptime notifications: email subjects sanitized against header injection. Expiry alerts deduplicated with 24h cooldown.
- Background tasks: `setInterval` with `.unref()` in hooks.server.ts. Overlap guards on both `runChecks` (60s) and `runDailyChecks` (24h).
- **ServiceError class** (`src/lib/server/service-error.ts`): User-facing service errors use `throw new ServiceError('error.i18nKey', { params })`. Translation happens at the API boundary in `translateServiceError` (`request-utils.ts`). HTTP status codes mapped via `SERVICE_ERROR_STATUS` record. Internal guards (not found, etc.) remain as plain `new Error` and are caught by pattern matching in `translateServiceError`.
- **Timezone-aware dates**: Recurring invoice generation and overdue marking use `Intl.DateTimeFormat` with the configured timezone from settings (sv-SE locale for ISO 8601 format), not server-local time.
- RMM agent-facing endpoints (`/api/rmm/*`) return `json({ error: '...' }, { status: N })` — never `throw error()` (which renders HTML). Agents parse JSON, not HTML.
- RMM validators live in `src/lib/validators-rmm.ts` (separate from main validators to avoid bloat).
- Agent detail page uses URL params for tab persistence (`?tab=packages`), not component state.
- Time formatting in agent components uses 24h format (`toLocaleTimeString('de-DE', { hour12: false })`).
- Package managers: `apps` source checks `brew list --cask` to exclude brew-managed apps. When adding a new package manager, implement the `Manager` interface in `agent/internal/packages/` and add to `detect.go`.
- `QuickCreate` menu: icon-only horizontal bar with `title` tooltips. When adding new items, add icon path + i18n key + href.
- Client dropdowns: use `getClientIdNames()` (id+name only) for edit pages. Use `getClientDropdownData()` (id+name+currency+language) for new pages that auto-fill from client selection. Never load full client blobs for dropdowns.
- `SESSION_SECRET` requires minimum 32 characters in production.
- RMM agent binary download (`/api/rmm/download`) requires cookie-based authentication.
- RMM enrollment (`/api/rmm/enroll`) is rate-limited (10 attempts per IP per 15-minute window). Rate limit records on failure only, not on every request.
- RMM `processCommandResult` requires `agentId` parameter — agents can only update results for their own commands (prevents cross-agent spoofing).
- Puppeteer renders with JavaScript **disabled** (`setJavaScriptEnabled(false)`) — eliminates XSS-via-HTML in PDF/thumbnail generation regardless of template validation completeness.
- Template event handler regex handles quoted attributes containing `>` — uses `(?:[^>'"]|'[^']*'|"[^"]*")*` instead of `[^>]*` to prevent bypass.
- SSRF: IPv6-mapped IPv4 addresses are normalized via `expandIPv6()` before checking, preventing bypass via expanded (`0000:...ffff:7f00:0001`) or hex (`::ffff:7f00:1`) representations.
- Backup restore sanitizes ticket descriptions via `sanitizeRichText()` — prevents stored XSS via `{@html}` rendering in TicketCard.
- Backup restore rejects databases containing triggers, views, or other non-table/non-index objects.
- Settings deep merge BANNED_KEYS includes `__defineGetter__`, `__defineSetter__`, `__lookupGetter__`, `__lookupSetter__` in addition to `__proto__`, `constructor`, `prototype`.
- Field crypto: decryption failures are logged at `console.error` level with actionable messages (re-enter credentials or restore original SESSION_SECRET). Silent `''` return is only for "no key" (dev mode).
- Notification error persistence: when Telegram/email notifications fail, the error is persisted to `uptime.lastNotifyError` in settings. Cleared on next successful delivery. UI can show a warning when alerts are broken.
- Backup restore uses explicit column mapping (`PRAGMA table_info`) when backup and current schemas differ (older/newer app versions). Shared columns are restored; new columns use defaults.
- Agent re-enrollment is recorded in audit log (`recordChange('agent', id, 'delete', { reason: 're-enrollment' })`) before deleting the old agent.
- `translateServiceError` returns generic error messages for non-ServiceError exceptions (M1 fix — prevents leaking internal error details to clients).
- API JSON responses include `Cache-Control: no-store` to prevent caching of sensitive data.
- HSTS header includes `preload` directive in production.
- Agent token authentication uses constant-time comparison (`timingSafeEqual`) matching the session token pattern.
- Template validation applies NFC normalization before regex matching to prevent Unicode decomposition bypasses.
- Template HTML blocklist includes resource-loading tags: `video`, `audio`, `source`, `picture`, `math` (in addition to script/iframe/svg/etc).
- Rate limiting for setup, enrollment, and email uses atomic check+record (`db.transaction`) to prevent TOCTOU bypass. Login uses separate check/record (acceptable gap due to bcrypt cost).
- Form action error strings use `serverT(lang)('error.key')` for i18n translation (matching login page pattern).

## RMM Settings

Configurable via Settings > RMM. Defaults in `validators-rmm.ts`:

| Setting | Default | Range | Purpose |
|---------|---------|-------|---------|
| `defaultCheckinInterval` | 60s | 10-3600s | Agent polling interval |
| `staleThresholdMinutes` | 5 | 1-60 | Base threshold for stale detection (2× = stale, 3× = offline) |
| `metricsRetentionHours` | 48 | 1-720 | Granular metrics retention (daily aggregates kept forever) |
| `commandTimeoutSeconds` | 300 | 5-3600 | Default per-command timeout |

Agent status values: `online` → `stale` (at 2× threshold) → `offline` (at 3× threshold).

## RMM Agent Security Model

The Go agent runs as a LaunchDaemon (macOS) / systemd service (Linux) = root.

**Privilege model:**
- Shell commands drop to console user (macOS: `/dev/console` owner) via `sudo -u`
- Brew/npm/pip refuse root — console user execution is intentional
- `sudo` prefix in commands uses root explicitly
- App uninstall uses `ExecuteAsRoot` (needs root for `/Applications` removal)

**Files created on macOS:**
- `/usr/local/bin/itcake-agent` — binary
- `/Library/Application Support/ITCake/agent-config.json` — config (mode 0600)
- `/Library/LaunchDaemons/com.itcake.agent.plist` — LaunchDaemon
- `/var/log/itcake-agent.log` — log

**Communication:** HTTPS polling with bearer token (HMAC-SHA256 hashed server-side). TLS enforced. Command signatures verified via HMAC-SHA256.

**Checkin payload caps:** stdout 1MB, stderr 256KB, packages 10,000 items.

**Architecture:** Server dispatches commands → agent executes → results returned in next checkin. Server is the control plane; agent is the execution plane.

## API Reference

All API routes return JSON. No HTML redirects. Errors are `{error: string}` or SvelteKit `{message: string}`.

### Authentication Groups

| Prefix | Auth | CSRF | Purpose |
|--------|------|------|---------|
| `/api/rmm/*` | Bearer token | Exempt | Agent-facing (enrollment, checkin, download) |
| `/api/agents/*` | Cookie session | Yes | UI-facing agent management |
| `/api/*` (other) | Cookie session | Yes | All other entity CRUD |
| `/api/auth/*` | None (pre-auth) | Yes | Login, register, logout |
| `/api/config` | None | N/A (GET) | Setup state check |

### Mutation Pattern

All entity CRUD uses action-based POST:
```json
POST /api/{entity}
{ "action": "update", "id": "...", ...data }   // update
{ "action": "delete", "id": "..." }             // delete
{ ...data }                                       // create (no action = default)
```

### Key Endpoints

| Method | Path | Auth | Purpose |
|--------|------|------|---------|
| GET | `/api/invoices` | Cookie | List invoices (paginated via ?page=&status=&q=) |
| POST | `/api/invoices` | Cookie | Create/update/delete invoice |
| GET | `/api/invoices/{id}/preview` | Cookie | HTML preview |
| GET | `/api/invoices/{id}/pdf` | Cookie | PDF download |
| POST | `/api/emails` | Cookie | Send email with attachment |
| GET | `/api/agents` | Cookie | List all agents |
| POST | `/api/agents/{id}/commands` | Cookie | Dispatch command to agent |
| POST | `/api/rmm/enroll` | Token | Agent enrollment |
| POST | `/api/rmm/checkin` | Bearer | Agent check-in (metrics, command results) |
| GET | `/api/events` | Cookie | SSE stream (real-time updates) |
| GET | `/api/search?q=` | Cookie | Global cross-entity search |

## Background Tasks (hooks.server.ts)

| Interval | Task |
|----------|------|
| 60min | Clean expired sessions |
| 60min | Process recurring invoices + mark overdue |
| 24h | Prune audit log (>1 year) |
| 60s | Uptime ping + HTTP checks for enabled monitors |
| 24h | Uptime domain/SSL expiry checks + daily aggregation + granular check pruning |
| Startup+10s | Recurring invoices + overdue marking |
| Startup+15s | Initial uptime checks + daily checks + aggregation |
| Startup+3s | Puppeteer warm-up |
| 60s | RMM: Stale agent detection + command expiry |
| 24h | RMM: Agent metrics aggregation + pruning |

## By Design — Not Bugs

These patterns look suspicious but are intentional. Do not flag them.

- **Single-session enforcement**: `createSessionTx` deletes all user sessions before inserting. Intentional for single-user app.
- **HMAC-SHA256 session tokens**: Production requires `SESSION_SECRET` (enforced at startup). Plain SHA256 fallback is dev-only.
- **0% tax groups filtered**: Cosmetic — totals computed from unfiltered data before filter.
- **Credit note parent item negation**: No-op — `computeItemSubtotal` ignores parent qty when children exist. Leaf items correctly negated.
- **iframe sandbox allow-same-origin**: CSP `default-src 'none'; script-src 'none'` on preview endpoints prevents execution.
- **sanitize-html img scheme override**: `allowedSchemesByTag` correctly overrides global list. External images stripped.
- **`backupInProgress` per-process**: Single-process deployment. Not a concern.
- **RDAP manual redirect following**: Uses `redirect: 'manual'` with per-hop SSRF validation via `resolveAndValidate()`. Max 5 redirects. Each hop hostname is checked against blocked IP ranges.
- **`translateServiceError` returns `never`**: Catch blocks use `return translateServiceError(e)` — the `return` is for control flow clarity, not value.
- **`sentAt` is sticky**: Records when a document was first sent. Not cleared on subsequent status changes (unlike `paidDate` which represents current payment state). A cancelled invoice that was once sent retains `sentAt` for audit trail.
- **`originalPaidDate` preserved on un-pay**: When an invoice transitions from `paid` → `sent` (rare correction), the original `paidDate` is saved to `originalPaidDate` before clearing `paidDate`. This preserves the audit trail without requiring an audit log query.
- **`kleinunternehmer` stored as explicit boolean**: Invoices, proposals, and tickets store `kleinunternehmer: true` or `kleinunternehmer: false` (not `undefined`). This distinguishes "explicitly not KU" from "created before the KU feature". Recurring invoice generation uses `current.kleinunternehmer ?? false` to prevent pre-feature invoices from inheriting a later-enabled KU setting.
- **Field crypto v1/v2 coexistence**: `decryptField` handles both `enc:` (v1, static salt) and `enc2:` (v2, per-field salt) formats. v1 values are transparently re-encrypted as v2 on next write. Do not remove v1 support while any encrypted values may still be in v1 format.
- **MUTABLE_FIELDS allowlists in updateInvoice/updateProposal**: `INVOICE_MUTABLE_FIELDS` and `PROPOSAL_MUTABLE_FIELDS` Sets control which fields callers can modify. New entity fields are immutable by default — add to the Set explicitly if they should be editable.
- **Open tickets can be converted to invoices**: `convertTicketToInvoice` intentionally allows both open and completed tickets. Requiring manual completion first would add unnecessary friction. The ticket is marked `invoiced` regardless.
- **`updateInvoice` does not handle status changes**: Status changes go exclusively through `updateInvoiceStatus`. The API route strips status from update payloads as a safety measure. Do not add status handling back to `updateInvoice`.
- **Agent shell commands run as console user, not root**: The agent process runs as root (LaunchDaemon), but `Execute()` drops to the macOS console user via `sudo -u`. This is intentional — brew, npm, pip refuse root. `ExecuteAsRoot()` is only used for app uninstall (needs root for `/Applications` removal). Users can prefix commands with `sudo` for explicit root access.
- **Agent re-enrollment replaces old agent**: When enrolling the same hostname+os+arch, the old agent row (and all its data) is deleted. This is intentional — the old token is invalidated, preventing stale daemons from checking in.
- **Brew casks excluded from `apps` source**: Apps installed via `brew install --cask` appear under `brew` (not `apps`) to avoid duplicate listings. The `apps` source only shows non-brew `/Applications/*.app` bundles. Uninstall paths differ: brew uses `--zap`, apps use AppCleaner-style deep cleanup.
- **Agent IP shows `::1` on localhost**: `getClientAddress()` returns IPv6 loopback for local connections. The agent also reports its LAN IP via UDP probe — the server prefers `localIp` from checkin payload over the connection IP.
- **Agent stale threshold is configurable**: Default 5 minutes (`staleThresholdMinutes` in RMM settings). Agent goes `stale` at 2× threshold (10min), `offline` at 3× (15min). Short thresholds ensure quick detection after `itcake-agent uninstall`.

## Upstream Dependencies (monitoring only)

- **cookie <0.7.0** (GHSA-pxg6-pf52-xh8x): Transitive via @sveltejs/kit. Near-zero exposure. Check `npm ls cookie` on updates.
- **yauzl <3.2.1** (GHSA-gmq8-994r-jv83): Transitive via puppeteer. Not used for user ZIPs. Check `npm ls yauzl` on updates.
