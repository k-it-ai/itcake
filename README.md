# ITCake

Single-user, self-hosted web app for a one-person IT business: invoicing, tickets and
time tracking, uptime monitoring, RMM (with a Go agent), and remote desktop.

Bare-metal / VM only — no Docker. Node serves the app; a reverse proxy terminates TLS.

## Why ITCake Exists

ITCake was born from a simple frustration: **running a one-person IT business shouldn't require five different SaaS subscriptions.**

Most solo consultants and small MSPs end up stitching together:
- Invoicing software (€0–50/mo)
- Ticketing/time tracking (€15–30/mo)
- Uptime monitoring (€0–35/mo)
- RMM/remote access (€130–210/user/mo or €190+/mo per 50 endpoints)
- Backup verification (manual or separate tool, €10–50/mo)

That's **€155–320/month forever**, plus your data lives in someone else's cloud.

ITCake bundles all of this into **one self-hosted application** you own completely.

---

## Philosophy

### 1. Self-Hosted First
Your data, your infrastructure, your rules. No vendor lock-in. No subscription that stops working when you stop paying. Run it on a $5 VPS, a home server, or a rack in your closet.

### 2. Security by Default, Not as an Add-On
- TOTP MFA with **step-up authentication** for every sensitive action
- **HMAC-chained audit log** — every change is cryptographically linked
- **Field-level AES-256-GCM encryption** with per-row AAD binding
- **TLS certificate pinning** for agent communication
- **SSRF-pinned outbound requests** — DNS rebinding attacks prevented by design

Security isn't a feature toggle. It's the foundation.

### 3. Built for the Solo Operator
No team management, no RBAC complexity, no "enterprise" bloat. One user. Full access. If you need to hand off to a colleague, export the data and spin up a second instance.

### 4. German Tax Compliance Built In
- Kleinunternehmer (§19 UStG) handling with **snapshot semantics** — toggle the setting mid-year, existing invoices keep their tax treatment
- Credit notes with proper VAT reversal
- GoBD-compliant audit trail with HMAC chain
- German date formats, currency, VAT rates out of the box

### 5. No Docker, No Kubernetes, No Complexity
Single binary (Node.js + Go agent). SQLite database. One `DATA_DIR` to back up. Deploy with systemd, runit, or a simple shell script.

---

## Features

- **Invoicing** — invoices, credit notes, proposals, clients, catalog items, templates,
  recurring schedules, PDF rendering (EJS + Puppeteer), partial payments.
- **Tickets & time tracking** — states, comments, attachments, ticket → invoice conversion.
- **Uptime monitoring** — ping / HTTP / SSL / domain expiry, alert rules, Telegram alerts,
  status timeline per monitor.
- **RMM** — Go agent (macOS / Linux / Windows) checking in over pinned TLS: metrics,
  packages, services, event log, script execution, file and package actions, self-update.
- **Remote desktop** — Apache Guacamole (guacd) supervised by the app, browser access via
  guacamole-common-js, optional session recording.
- **Backups** — local ZIPs (optionally AES-256-GCM encrypted) with retention pruning and an
  integrity + test-restore verification ladder.
- **Security** — TOTP MFA with step-up gates, audited change log with HMAC chain and
  truncation detection, field-level encryption, SSRF-pinned outbound requests.

---

## Who Should Use ITCake

✅ **Solo consultants** billing clients, tracking time, managing uptime  
✅ **Small MSPs** (1–3 people) needing RMM + ticketing + invoicing  
✅ **DevOps engineers** wanting self-hosted monitoring + remote access  
✅ **Anyone** tired of paying €200/mo for tools they barely use  

❌ **Teams needing RBAC / multi-user** — not the target  
❌ **Cloud-only shops** — this runs on your iron  
❌ **Enterprise compliance checkboxes** — SOC2, HIPAA, etc. not targeted  

---

## Stack

SvelteKit 3 (Svelte 5) + adapter-node, TypeScript, better-sqlite3 (WAL), Tailwind v4,
Vite, Zod, Nodemailer, Puppeteer, EJS, guacamole-lite. Go agent in `agent/` with its own
`go.mod` (built `CGO_ENABLED=0 -trimpath -buildvcs=false -ldflags='-s -w'`).

## Quickstart

```sh
npm ci
cp .env.example .env        # set SESSION_SECRET at minimum
npm run dev                 # http://127.0.0.1:3000 → /setup on first run
```

Production:

```sh
npm run build
NODE_ENV=production node build/index.js   # under systemd/runit, proxy TLS in front
```

`DATA_DIR` must be writable and persisted: it holds the database, uploads, backups,
agent binaries and recordings.

## Environment variables

| Variable | Default | Purpose |
| --- | --- | --- |
| `DATABASE_PATH` | `data/itcake.db` | SQLite path |
| `DATA_DIR` | `data` | Uploads, backups, agent binaries, recordings |
| `HOST` / `PORT` | `127.0.0.1` / `3000` | Bind address |
| `ORIGIN` | — | Public origin; required in production for CSRF checks |
| `NODE_ENV` | — | `production` enforces secure cookies + `SESSION_SECRET` |
| `SESSION_SECRET` | — | ≥32 chars in prod. HMAC for sessions, at-rest encryption, audit chain |
| `ADDRESS_HEADER` | — | Real client IP behind a reverse proxy (only with loopback `HOST`) |
| `TRUST_PROXY` | — | Allows `ADDRESS_HEADER` with non-loopback `HOST` |
| `LOG_LEVEL` | `info` | NDJSON logger level |
| `PUPPETEER_NO_SANDBOX` | `false` | Disable Chromium sandbox where required (set `true` only in CI/Docker where sandbox unavailable) |
| `ITCAKE_UPDATE_MANIFEST_PUBKEYS` | — | Comma-separated Ed25519 pubkeys; agents then require a signed update manifest |

SMTP, Telegram, AI and Guacamole are configured in-app, not via env.

## Project structure

```
src/
  routes/(app)/           Authenticated pages (v2 sidebar + command palette)
  routes/api/             POST {action, ...} JSON endpoints (handleActionPost)
    rmm/                  Bearer-authenticated agent endpoints (checkin, enroll, download)
    health/ healthz/      Liveness / deep readiness (DB + disk + puppeteer + shutdown)
  lib/server/             DB, auth, crypto, audit changes, shutdown, rate limit, logging
  lib/components/         UI primitives (v2) + shell (sidebar, top bar, palette)
  lib/i18n/               en.ts / de.ts + server-side error translation
  services/               Business logic (invoices, backups, agents, alerts, emails, …)
agent/                    Go RMM agent (cmd/agent + internal/*)
tests/                    integration/lifecycle.test.ts (real server) + tests/unit/*
assets/templates/         Invoice/proposal EJS + PDF string tables (en/de)
scripts/                  rotate-session-secret.mjs
docs/                     openapi.yaml (external surface), test-plan.md, test-results.md
```

Documents (invoices, clients, tickets, …) are rows in `documents(id, type, data JSON)`.
Two mutation paths exist and are not mixed: JSON API routes and SvelteKit form actions.
All DB mutations run inside `db.transaction()` with `recordChange()` in the same
transaction.

## Development

```sh
npm run dev                       # dev server
npm run check                     # svelte-kit sync + svelte-check (0 errors expected)
npm test                          # unit tests (vitest)
PUPPETEER_NO_SANDBOX=true npx vitest run tests/integration/lifecycle.test.ts
npm run build                     # production build
npm run build:agent               # build the Go agent for the host OS/arch
npm run build:agent:all           # build all 6 release targets into data/agent-binaries
```

Conventions worth knowing before changing things:

- **Money is integer cents everywhere.** Rounding is half away from zero so mirrored
  amounts (credit note vs. invoice) stay exact negatives.
- **UI strings:** add keys to both `src/lib/i18n/en.ts` and `de.ts`; PDF strings live in
  `assets/templateStrings/{en,de}.json`. `i18n-parity.test.ts` enforces parity.
- **Adding a settings key / document type / command type / collector kind:** update every
  allowlist in `lib/server/backup-allowlists.ts` and the matching CHECK constraint (the
  table comments and `validators-*.ts` list the exact spots). Backups validate against
  these allowlists on restore.
- **`payloadRaw` for agent commands is verbatim DB bytes.** Re-marshalling breaks the
  per-agent HMAC signature.
- **Tests are mandatory** for behaviour changes: `tests/unit/` or the lifecycle suite.
- **Errors** are `throw new ServiceError('error.key', { detail })`, translated at the API
  boundary.

## Encryption and credentials

- `enc3:` fields are AES-256-GCM (HKDF + per-blob salt + AAD) keyed by a scrypt derivation
  of `SESSION_SECRET`. AAD binds each ciphertext to its identity, so cross-row copies fail
  the GCM check. Legacy `enc2:` is re-wrapped on boot.
- Encrypted surfaces: settings credentials (SMTP password, Telegram token, AI key, backup
  passphrase, update-manifest key, telemetry DSN), per-row credentials
  (agent HMAC secret, agent remote-desktop password/key, user TOTP secret), and the audit
  anchor chain.
- Local backups can additionally be AES-256-GCM encrypted with a passphrase independent of
  `SESSION_SECRET`; the passphrase ciphertext is stripped from the in-zip settings row.
- Agent token hashes use a per-install pepper stored in settings, so rotating
  `SESSION_SECRET` does not lock out enrolled agents.
- Outbound requests (SMTP, Telegram, Anthropic, uptime checks, RDAP, error
  reporting) pin the DNS-resolved IP while keeping SNI on the hostname.
- Update manifests can be Ed25519-signed; configure accepted pubkeys via
  `ITCAKE_UPDATE_MANIFEST_PUBKEYS` (comma-separated base64) to enforce signature
  verification on agent self-update.

## Operator runbook

| Task | Steps |
| --- | --- |
| Deploy | `npm run build`, run `node build/index.js` under systemd/runit, persist `DATA_DIR`, proxy TLS in front of `HOST:PORT` |
| External monitoring | Point an external monitor at `/api/health` (liveness) and `/api/healthz` (DB + disk + puppeteer), which returns 503 on failure |
| Revoke a compromised agent | `POST /api/agents { action: 'delete', id }` — bearer + per-row HMAC stop working immediately |
| Endpoint compromise | Treat the host as lost: revoke the agent, close remote-desktop popups, re-image, re-enrol with a fresh token, rotate credentials that transited the machine |
| Rotate compromised `SESSION_SECRET` | Stop → `node scripts/rotate-session-secret.mjs --db data/itcake.db --old <HEX> --new <HEX>` (dry-run first; exits 2 on preflight failure, 1 with rollback) → set the new value → start. Re-generate TOTP recovery codes afterwards |
| Restore from backup | UI → Backups → Restore. `.zip.enc` needs the original passphrase; restoring on a host with a different `SESSION_SECRET` makes encrypted fields unrecoverable |
| Rotate local-backup passphrase | `POST /api/backups { action: 'rotate_passphrase', password, newPassphrase }` (admin password + MFA step-up) |
| Audit-log integrity | `GET /api/changes/integrity` → `{ total, verified, unverified, tamperedIds, anchor }`. `anchor: 'mismatch'` or `'tail-truncated'` is a real incident unless preceded by a documented rotation or annual prune |
| Inspect long-running tasks | `GET /api/tasks?limit=50` (`backup`, `restore`, `passphrase rotation`, `audit check`), pruned after 90 days |
| Install/update Guacamole | Settings → Remote Desktop → Install/Update (OS package manager). guacd binds 127.0.0.1:4822 |

Background maintenance (installed by `hooks.server.ts`, all intervals `.unref()`d and
boot-seeded so restarts cannot skip them): 60 s uptime checks / stale detection / command
expiry / schedules / alerts; hourly session cleanup and recurring invoices; 24 h pruning
(uptime history, RMM metrics and events, audit log > 1 year, local backups), audit
integrity check.

## RMM agent

Enrol from the UI (one-time 15-minute token), then install the service binary from
`data/agent-binaries/`:

| OS | Binary | Config |
| --- | --- | --- |
| macOS | `/usr/local/bin/itcake-agent` (LaunchDaemon) | `/Library/Application Support/ITCake/agent-config.json` (0600) |
| Linux | `/usr/local/bin/itcake-agent` (systemd) | `/etc/itcake-agent/config.json` (0600) |
| Windows | `C:\ProgramData\ITCake\itcake-agent.exe` (SCM service) | `C:\ProgramData\ITCake\agent-config.json` (SYSTEM + Admins only) |

Commands are HMAC-signed with the per-agent secret (verbatim `payloadRaw`), verified with a
±10-minute window and a persistent replay cache. Self-updates verify the advisory HMAC,
SHA-256 / `Content-Digest`, and optionally an Ed25519 manifest signature before the binary
is swapped in. `--insecure` skips certificate pinning for enrolment only and is never
persisted; use `--pin-tls` to capture the leaf SPKI.

Tag format: `[a-z0-9_-]`, max 30 tags of 50 chars.

## CI

`.github/workflows/ci.yml` runs two path-gated jobs:

- **app** — type-check, unit tests, production build, integration lifecycle suite
  (triggered by `src/**`, `tests/**`, `scripts/**`, package/config files).
- **agent** — `go vet`, `govulncheck`, `go test`, cross-build for all 6 targets
  (triggered by `agent/**`).

Auxiliary workflows: weekly security audit + rolling dependency issue, weekly CycloneDX
SBOMs, workflow lint, tag-driven agent releases (`agent-v*`), dependabot auto-merge for
minor/patch bumps.

## Upstream advisories

None currently carried. An upstream advisory that is acceptable to live with (with a
one-line reason and a re-review trigger) is recorded in
`.github/acknowledged-advisories.json`; keep that list in lock-step with this section and
the `allow-ghsas` input of `.github/workflows/dependency-review.yml`.

## The Name

**ITCake** — because IT + Cake. You get the whole cake (all features), you own the cake (self-hosted), and it's sweet (good UX, good code).

---

## Contributing

ITCake is **not accepting external contributions** at this stage. The codebase is opinionated, the architecture is tight, and the security model relies on a small, auditable codebase.

If you find a bug: **open an issue** with reproduction steps.  
If you have a feature request: **open an issue** with the use case.  
If you want to build something similar: **fork it** — the code is readable, the tests are comprehensive.

## Support

No SLAs. No support contracts. No guaranteed response times.

- **Bugs:** GitHub Issues
- **Security:** GitHub Security Advisories (private reporting)
- **Questions:** Read the code — it's documented and tested

## Acknowledgments

Built with excellent open-source projects:
- SvelteKit / Svelte 5
- better-sqlite3
- Tailwind CSS v4
- Zod
- Puppeteer
- guacamole-lite / guacamole-common-js
- @anthropic-ai/sdk
- bcryptjs
- dayjs
- jszip
- nodemailer
- sanitize-html
- And many more...

## License

UNLICENSED — all rights reserved.