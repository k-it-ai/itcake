# About ITCake

## Why ITCake Exists

ITCake was born from a simple frustration: **running a one-person IT business shouldn't require five different SaaS subscriptions.**

Most solo consultants and small MSPs end up stitching together:
- Invoicing software (€20–50/mo)
- Ticketing/time tracking (€15–30/mo)
- Uptime monitoring (€10–25/mo)
- RMM/remote access (€20–100/mo)
- Backup verification (manual or another tool)

That's €100–200/month **forever**, plus your data lives in someone else's cloud.

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

## What's Inside

| Module | Purpose |
|--------|---------|
| **Invoicing** | Invoices, credit notes, proposals, clients, catalog, recurring schedules, PDF rendering |
| **Tickets** | States, comments, attachments, time tracking, ticket → invoice conversion |
| **Uptime** | Ping / HTTP / SSL / domain expiry checks, alert rules, Telegram/email alerts |
| **RMM** | Go agent (macOS/Linux/Windows) — metrics, packages, services, scripts, self-update |
| **Remote Desktop** | Apache Guacamole (guacd) supervised, browser-based, optional recording |
| **Backups** | Local encrypted ZIPs, retention, integrity verification, test-restore ladder |
| **AI Assistant** | Local-first (tool use, budget, session resume) — optional, configurable |

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

## Project History

ITCake started as a personal tool in 2023 — a weekend project to replace my own €150/mo tool stack. It grew because:

1. **I needed it** — real problems get real solutions
2. **Security was non-negotiable** — I couldn't trust my clients' data to a half-baked auth system
3. **German tax law is weird** — Kleinunternehmer snapshots, credit note VAT, GoBD audit trails
4. **RMM agents are fun** — writing a cross-platform Go agent with HMAC-signed commands is genuinely enjoyable

---

## Current Status

**Version:** 0.1.0 (Active development)  
**License:** UNLICENSED — all rights reserved  
**Stack:** SvelteKit 3 (Svelte 5) + TypeScript + better-sqlite3 + Tailwind v4 + Go agent  
**Tests:** 1,286 unit + 58 integration scenarios  
**Security:** 0 known vulnerabilities (`govulncheck` clean)  

---

## Contributing

ITCake is **not accepting external contributions** at this stage. The codebase is opinionated, the architecture is tight, and the security model relies on a small, auditable codebase.

If you find a bug: **open an issue** with reproduction steps.  
If you have a feature request: **open an issue** with the use case.  
If you want to build something similar: **fork it** — the code is readable, the tests are comprehensive.

---

## Support

No SLAs. No support contracts. No guaranteed response times.

- **Bugs:** GitHub Issues
- **Security:** GitHub Security Advisories (private reporting)
- **Questions:** Read the code — it's documented and tested

---

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

---

## The Name

**ITCake** — because IT + Cake. You get the whole cake (all features), you own the cake (self-hosted), and it's sweet (good UX, good code).

---

*"The best tool is the one you own."*
