# ITCake

Single-user self-hosted web invoicing app with ticketing, time tracking, and uptime monitoring.

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
├── Clients           CRUD, auto-numbered (C-001), address, VAT, contact
├── Expenses          CRUD, receipt uploads (JPG/PNG/WebP/PDF), categories
├── Catalog items     Reusable line item presets (name, price, unit, tax)
├── Units             Custom measurement units
├── Templates         9 built-in + custom EJS, options (colors/fonts/booleans)
│   ├── Sandbox       Custom templates: only <%= %> allowed, CSS url() data:-only
│   ├── Import/export Single-file JSON
│   └── Thumbnails    Puppeteer-rendered, LRU cached
├── Reports           Revenue + tax breakdown by year/month
├── Dashboard         Monthly revenue chart, summary stats
├── Audit log         All mutations tracked, 1-year retention, auto-pruned
├── Backup/restore    ZIP (SQLite + uploads), validation before restore, preview
├── Global search     Cross-entity (invoices, proposals, clients, tickets, expenses)
└── Settings          Company, invoice/proposal defaults, SMTP, advanced
    └── Kleinunternehmer   §19 UStG small business VAT exemption (zeroes tax rates)

Uptime monitoring
├── Check types       ping (execFile), HTTP (fetch), SSL expiry (tls), domain expiry (RDAP)
├── History           Granular checks (48h TTL) → daily aggregates (forever)
├── Notifications     Telegram + email, 24h cooldown on expiry alerts
├── SSE events        Real-time status updates to dashboard
└── SSRF protection   DNS-resolved private IP rejection on all outbound checks

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

## Directory Layout

```
src/
  routes/           SvelteKit pages + API routes
    (app)/           Authenticated app pages (layout requires login)
      tickets/       Ticket/time-tracking dashboard
      uptime/        Uptime monitoring dashboard
    api/             JSON API endpoints
      tickets/       Ticket CRUD + status + convert-to-invoice APIs
      monitors/      Monitor CRUD + history APIs
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
  lib/
    server/          Server-only: auth, db, pdf, email, rate-limit, sanitize (shared escapeHtml/sanitizeHeader), template rendering
      checks/        Uptime check implementations (ping, http, ssl, rdap) + target validation
    i18n/            Translation files (en, de)
    stores/          Svelte stores (theme)
    money.ts         Billing math (cents-based, integer arithmetic)
    validators.ts    Zod schemas for all entities
    types.ts         TypeScript interfaces
  services/          Business logic layer (invoices, proposals, clients, tickets, monitors, etc.)
assets/
  templates/         EJS invoice/proposal templates + master template
  templateStrings/   Per-language translation JSON for templates (en, de)
tests/
  unit/              Unit tests (billing math, validators, etc.)
  integration/       Integration tests (services, DB operations)
data/                Runtime: SQLite DB, uploads, backups (gitignored)
```

## Document Store

`documents` table: `id TEXT PK, type TEXT, data TEXT (JSON), created_at, updated_at`.
All entity data lives in the `data` JSON blob. Services use helpers from `db.ts`:
`getDocument`, `getDocumentsByType`, `insertDocument`, `updateDocument`, `deleteDocument`.
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
| Template strings | `assets/templateStrings/{en,de}.json` | PDF/invoice rendering | `t('key')` in EJS via `getTemplateStrings(lang)` |

UI labels → add to `en.ts` + `de.ts`. PDF labels → add to both JSON files in `templateStrings/`.

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
- `VALID_SETTINGS_KEYS` — settings keys (general, company, invoices, proposals, emails, advanced, uptime)
- `VALID_ENTITY_TYPES` — audit log entity types (invoice, monitor, ticket, ...)
- `VALID_ACTIONS` — audit log actions (create, update, delete, status_change, reopen, send_email)
- `BUILT_IN_TEMPLATE_IDS` — built-in template names

Forgetting these causes backup restore to reject valid backups silently.

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
```

## Conventions

- Money in integer cents everywhere (10000 = €100.00). Never float for money.
- Discount rounding reconciliation: when discounts span multiple tax groups, per-group rounding can diverge by 1-2 cents. `computeInvoiceTotals` adjusts the largest group to absorb the remainder (standard accounting rounding allocation).
- Template option keys: restricted to valid identifiers (`/^[a-zA-Z][a-zA-Z0-9_]*$/`) to prevent `__proto__`/`constructor` injection via Zod schema.
- All DB mutations wrapped in `db.transaction()`. Audit log via `recordChange()`.
- API routes use `parseJsonBody()` (streaming, size-limited) + Zod validation.
- CSRF: Origin/Referer check in hooks.server.ts for all state-changing requests.
- File uploads: magic byte verification, path traversal guards, extension allowlists.
- EJS templates: custom templates sandboxed via allowlist (no `<% %>` or `<%- %>`). Built-in templates are trusted.
- Settings deep-merged with prototype pollution protection (BANNED_KEYS).
- Uptime checks: DNS-pinned SSRF protection — `resolveAndValidate()` returns validated IP, used directly by ping/HTTP/SSL checks to prevent DNS rebinding.
- Session tokens: constant-time comparison via `crypto.timingSafeEqual` (fetches all active sessions, compares in JS).
- At-rest encryption: `smtp.pass` and `telegram.botToken` encrypted with AES-256-GCM (key from `SESSION_SECRET`) in the settings table. `getSetting` decrypts on read; `setSetting` encrypts on write. Startup migration encrypts existing plaintext. No-op without `SESSION_SECRET` (dev mode).
- Backup encryption: same `encryptField`/`decryptField` — backup creation ensures `enc:` prefix; restore copies encrypted values as-is (no decrypt step; `getSetting` handles it transparently).
- Uptime notifications: email subjects sanitized against header injection. Expiry alerts deduplicated with 24h cooldown.
- Background tasks: `setInterval` with `.unref()` in hooks.server.ts. Overlap guards on both `runChecks` (60s) and `runDailyChecks` (24h).

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

## By Design — Not Bugs

These patterns look suspicious but are intentional. Do not flag them.

- **Single-session enforcement**: `createSessionTx` deletes all user sessions before inserting. Intentional for single-user app.
- **HMAC-SHA256 session tokens**: Production requires `SESSION_SECRET` (enforced at startup). Plain SHA256 fallback is dev-only.
- **0% tax groups filtered**: Cosmetic — totals computed from unfiltered data before filter.
- **Credit note parent item negation**: No-op — `computeItemSubtotal` ignores parent qty when children exist. Leaf items correctly negated.
- **iframe sandbox allow-same-origin**: CSP `default-src 'none'; script-src 'none'` on preview endpoints prevents execution.
- **sanitize-html img scheme override**: `allowedSchemesByTag` correctly overrides global list. External images stripped.
- **`backupInProgress` per-process**: Single-process deployment. Not a concern.
- **RDAP `redirect: 'follow'`**: `rdap.org` is hardcoded (not user-controlled), always 302s to the authoritative server. Safe to follow.
- **`translateServiceError` returns `never`**: Catch blocks use `return translateServiceError(e)` — the `return` is for control flow clarity, not value.
- **`sentAt` is sticky**: Records when a document was first sent. Not cleared on subsequent status changes (unlike `paidDate` which represents current payment state). A cancelled invoice that was once sent retains `sentAt` for audit trail.
- **Field crypto v1/v2 coexistence**: `decryptField` handles both `enc:` (v1, static salt) and `enc2:` (v2, per-field salt) formats. v1 values are transparently re-encrypted as v2 on next write. Do not remove v1 support while any encrypted values may still be in v1 format.
- **MUTABLE_FIELDS allowlists in updateInvoice/updateProposal**: `INVOICE_MUTABLE_FIELDS` and `PROPOSAL_MUTABLE_FIELDS` Sets control which fields callers can modify. New entity fields are immutable by default — add to the Set explicitly if they should be editable.

## Upstream Dependencies (monitoring only)

- **cookie <0.7.0** (GHSA-pxg6-pf52-xh8x): Transitive via @sveltejs/kit. Near-zero exposure. Check `npm ls cookie` on updates.
- **yauzl <3.2.1** (GHSA-gmq8-994r-jv83): Transitive via puppeteer. Not used for user ZIPs. Check `npm ls yauzl` on updates.
