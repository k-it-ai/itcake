# ITCake — Redesign v2 · Implementation handoff

This folder is the **complete spec package** for porting `itcake-redesign-v2.html` to the production SvelteKit app at `github.com/kossov-it/itcake`.

## Source-of-truth files (in this project)

| File | Role |
|---|---|
| `itcake-redesign-v2.html` | Canonical visual reference (open it side-by-side while implementing) |
| `v2-primitives.jsx` | All shared atoms: `Tag`, `Dot`, `Pin`, `I` (icons), `Btn`, `FilterChip`, `StatusPill`, `Bar`, `Spark`, `Avatar`, `Card`, `SectionHead` |
| `v2-shell.jsx` | `Sidebar`, `TopBar`, `Frame` (layout + breadcrumb + ⌘K trigger), nav config + nav-icon set |
| `v2-pages-billing.jsx` | Dashboard · Invoices · Proposals · Clients · Catalog · Expenses · Reports |
| `v2-pages-ops.jsx` | Tickets (list + calendar) · Agents list · Agent detail · Agent enroll · Uptime |
| `v2-pages-misc.jsx` | Audit log · Settings · ⌘K palette |
| `v2-review.jsx` | The "What changed in v2" artboard — read this first |

## What changed vs v1

1. **"Production" badge removed.** Replaced with breadcrumb + page subtitle.
2. **Topbar reset** to one rhythm: breadcrumb + page title + sub (left) · ⌘K trigger (centre-right) · primary action (right).
3. **Sidebar darkened** (`--nav: #0f1418`), tightened (228 px), cyan reserved for the active item only.
4. **Status system unified** — `good / brand / warn / bad / accent / neutral`. Soft-fill + matching dot. Reused everywhere.
5. **⌘K palette** — refined density, scope chips, command verbs, footer hint with `↑↓ ↵ ⌘↵`.
6. **Tables** standardised — `12.5 px` body, `10.5 px` uppercase headers, `1px` hairlines (`--line-2`), tabular nums, monospaced IDs, monetary right-aligned.
7. **New pages cloned from `main`:** Tickets list+calendar, Expenses, Reports, Catalog, Proposals pipeline, Agent detail tab set, Agent enroll, Uptime, Audit log, tabbed Settings.

## Migration plan (recommended order)

1. **Tokens** → `01-design-tokens.md` → port to `src/app.css` (CSS vars) and `tailwind.config.js`.
2. **Primitives** → `03-primitives.md` → build before any page (everything else composes them).
3. **Shell** → `04-shell.md` → `+layout.svelte`, `Sidebar.svelte`, `TopBar.svelte`, `CommandPalette.svelte`.
4. **Dashboard + Invoices + Tickets** first (highest-traffic pages).
5. **Agents detail** before Agents list (detail is the harder layout; list reuses primitives).
6. **Proposals · Clients · Catalog · Expenses · Reports** can parallelise.
7. **Uptime · Audit log · Settings** last — least interactive logic.

## Reading order for an implementer new to the design

1. Open `index.html` in this folder for a navigable map.
2. `00-README.md` (this file)
3. `01-design-tokens.md`
4. `02-typography.md`
5. `03-primitives.md`
6. `04-shell.md`
7. `05-pages.md` (one section per page)
8. `06-status-system.md`
9. `07-data-viz.md`
10. `08-states.md` (empty / loading / error)
11. `09-a11y-motion.md`
12. `10-svelte-map.md`

## Delta vs the existing `/handoff/`

The earlier handoff folder still has accurate notes about:

- `DATA-MODEL.md` (entity schemas)
- `API.md` (REST surface)
- `SVELTE-STRUCTURE.md` (folder skeleton)

Keep those as the **data + API + folder layout reference**. This `handoff-v2/` overrides anything visual: tokens, primitives, shell, page layouts, status system. Where the two disagree, **v2 wins**.
