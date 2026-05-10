# 10 · Svelte file map

Delta against the existing `/handoff/SVELTE-STRUCTURE.md`. Where this disagrees, **v2 wins**.

```
src/
├── app.html
├── app.css                          # CSS vars (port of itcake-redesign-v2.html :root)
├── app.d.ts
│
├── lib/
│   ├── components/
│   │   ├── ui/                      # primitives — see handoff-v2/03-primitives.md
│   │   │   ├── Tag.svelte
│   │   │   ├── Dot.svelte
│   │   │   ├── Pin.svelte
│   │   │   ├── Btn.svelte
│   │   │   ├── FilterChip.svelte
│   │   │   ├── StatusPill.svelte
│   │   │   ├── Bar.svelte
│   │   │   ├── Spark.svelte
│   │   │   ├── Avatar.svelte
│   │   │   ├── Card.svelte
│   │   │   ├── SectionHead.svelte
│   │   │   ├── Toggle.svelte        # auto-update pill toggle
│   │   │   ├── Skeleton.svelte
│   │   │   ├── EmptyState.svelte
│   │   │   ├── ErrorState.svelte
│   │   │   └── Kbd.svelte           # ⌘K, ⌘N tile
│   │   │
│   │   ├── shell/
│   │   │   ├── Sidebar.svelte       # nav + user pod
│   │   │   ├── TopBar.svelte        # breadcrumb · title · sub · ⌘K · actions
│   │   │   ├── Frame.svelte         # composes Sidebar + TopBar + slot
│   │   │   └── CommandPalette.svelte
│   │   │
│   │   ├── viz/
│   │   │   ├── BarChart.svelte      # stacked monthly revenue
│   │   │   ├── UptimeStrip.svelte   # 90-day cells
│   │   │   ├── BootBars.svelte      # 14-day boot performance
│   │   │   └── PostureGrid.svelte   # 2-col pass/warn/fail tiles
│   │   │
│   │   ├── billing/
│   │   │   ├── InvoiceStatus.svelte # InvStatus → StatusPill wrapper
│   │   │   ├── ProposalCard.svelte
│   │   │   ├── ExpenseRow.svelte
│   │   │   └── TaxSummaryTable.svelte
│   │   │
│   │   ├── ops/
│   │   │   ├── AgentRow.svelte
│   │   │   ├── MetricCell.svelte    # Bar + label, tone shifts
│   │   │   ├── FindingsChips.svelte
│   │   │   ├── HardwareWarranty.svelte
│   │   │   ├── CISAuditCard.svelte
│   │   │   ├── BootPerformance.svelte
│   │   │   ├── AutoUpdate.svelte
│   │   │   ├── TagsEditor.svelte
│   │   │   └── TicketsCalendar.svelte
│   │   │
│   │   ├── audit/
│   │   │   ├── EventRow.svelte      # actor · verb · resource · diff
│   │   │   └── DiffLine.svelte
│   │   │
│   │   └── settings/
│   │       ├── SettingsNav.svelte
│   │       └── Field.svelte
│   │
│   ├── icons/                       # re-exports from lucide-svelte (see 03-primitives §I)
│   │   └── index.ts
│   │
│   ├── stores/
│   │   ├── nav.ts                   # nav config + derived badges
│   │   ├── palette.ts               # ⌘K open state, query, scope, results
│   │   ├── selection.ts             # bulk-select per route
│   │   ├── prefs.ts                 # density, theme, locale (localStorage + sync)
│   │   └── notifications.ts
│   │
│   ├── api/                         # see existing handoff/API.md
│   ├── types/
│   └── utils/
│       ├── format.ts                # money / date / duration / pct
│       ├── status.ts                # state→tone maps (06-status-system.md)
│       ├── hotkey.ts                # bind global keys
│       └── highlight.ts             # palette substring matcher
│
└── routes/
    ├── +layout.svelte               # mounts Frame, CommandPalette, GlobalKeys
    ├── +layout.ts
    ├── +page.svelte                 # Dashboard
    ├── tickets/
    │   ├── +page.svelte             # list + calendar (toggle in toolbar)
    │   └── [id]/+page.svelte
    ├── invoices/
    │   ├── +page.svelte             # list with saved-view tabs
    │   ├── new/+page.svelte
    │   └── [id]/+page.svelte
    ├── proposals/
    │   ├── +page.svelte             # pipeline
    │   └── [id]/+page.svelte
    ├── expenses/
    │   ├── +page.svelte
    │   └── [id]/+page.svelte
    ├── clients/
    │   ├── +page.svelte
    │   └── [id]/+page.svelte
    ├── catalog/+page.svelte
    ├── reports/+page.svelte
    ├── agents/
    │   ├── +page.svelte             # list
    │   ├── new/+page.svelte         # enroll
    │   └── [id]/
    │       ├── +layout.svelte       # tab strip
    │       ├── +page.svelte         # Overview
    │       ├── terminal/+page.svelte
    │       ├── packages/+page.svelte
    │       ├── services/+page.svelte
    │       ├── schedules/+page.svelte
    │       ├── events/+page.svelte
    │       ├── remote/+page.svelte
    │       └── findings/+page.svelte
    ├── uptime/
    │   ├── +page.svelte
    │   └── [id]/+page.svelte
    ├── audit/+page.svelte
    └── settings/
        ├── +layout.svelte           # left list + right slot
        ├── +page.svelte             # redirect → workspace/general
        └── [group]/[item]/+page.svelte
```

## What's new vs the v1 handoff

- `lib/components/ui/` is the canonical primitive set (matches `v2-primitives.jsx`).
- `lib/components/shell/` replaces v1's `AppShell` — three components, not one monolith.
- `viz/` is split out so charts can be lazy-loaded on Reports / Agent detail.
- `audit/`, `ops/`, `billing/` group page-specific atoms — keeps page files thin.
- `routes/agents/[id]/` becomes a layout + tab routes (was a single tabbed page in v1). Cleaner deep-linking, better caching.
- `routes/settings/[group]/[item]` is the v2 tabbed sub-route pattern.

## Port checklist

- [ ] Port `:root` tokens from `itcake-redesign-v2.html` lines 15–39 → `src/app.css`.
- [ ] Tailwind config: extend with the brand/severity colour tokens (see `01-design-tokens.md`).
- [ ] Build all 16 primitives in `lib/components/ui/`.
- [ ] Build shell trio + palette.
- [ ] Implement `Dashboard`, `Invoices`, `Tickets` first.
- [ ] Then `Agents` list → detail → enroll.
- [ ] Then `Proposals`, `Clients`, `Catalog`, `Expenses`, `Reports`.
- [ ] Then `Uptime`, `Audit`, `Settings`.
- [ ] Wire ⌘K palette to a fuzzy-search index over (clients, invoices, tickets, agents) + a static command list.
- [ ] Implement empty/loading/error states per `08-states.md`.
- [ ] Pass a11y audit per `09-a11y-motion.md`.
