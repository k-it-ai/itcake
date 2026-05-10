# 04 · App shell

Source: `v2-shell.jsx`. Three components compose the chrome on every page: `Sidebar`, `TopBar`, `Frame`.

---

## `Frame`

Top-level layout per page.

```jsx
<Frame
  active="invoices"             /* highlights nav item */
  title="Invoices"
  breadcrumb={['Billing','Invoices']}
  sub="optional grey suffix to the title"
  right={<…primary actions…>}
>
  …page body…
</Frame>
```

Structure:

```
<div class="w-full h-full flex" style="background: var(--bg)">
  <Sidebar active=…/>
  <main class="flex-1 flex flex-col min-w-0">
    <TopBar … />
    <div class="flex-1 overflow-auto p-5">{slot}</div>
  </main>
</div>
```

Body padding `p-5` (= 20 px) is the universal page gutter. Override only for full-bleed embeds (none currently).

---

## `Sidebar`

Fixed-width `228 px`, dark (`--nav`), non-collapsible in v2 (collapse is a v3 feature flag — leave room but don't ship).

### Structure

```
┌─ Brand block ─────────┐  16/16 px padding
│  K logo  ITCake       │  28 px square logo, brand-2 fill, brand-ink path
│            Operator   │  10 px muted subtitle
│            workspace  │
└───────────────────────┘
┌─ Nav ─────────────────┐  flex-1, overflow-auto, 8 px H padding
│  WORKSPACE            │  10 px uppercase tracking-wider, muted
│  ▸ Dashboard          │
│  ▸ Tickets         7  │  badge
│  ▸ Invoices        3  │  badge
│  ▸ Proposals          │
│  ▸ Expenses           │
│  ▸ Clients            │
│  ▸ Catalog            │
│  ▸ Reports            │
│                       │
│  OPERATIONS           │
│  ▸ Agents          2  │  badgeTone: bad (red dot bg)
│  ▸ Uptime             │
│  ▸ Audit log          │
│                       │
│  SYSTEM               │
│  ▸ Settings           │
└───────────────────────┘
┌─ User pod ────────────┐  m-2, p-2.5, rounded-lg
│  [JD] Jane Doe   ▾ │
│       example.com · Owner │
└───────────────────────┘
```

### Item state

- Inactive: bg transparent, text `#dde3ea`, icon `opacity .8`.
- Active: bg `--nav-active` (`#11353f`), text + icon `--nav-active-text` (`--brand-2`, `#5cd2ee`).
- Hover (not in proto, add): bg `rgba(255,255,255,.04)`.

Each item:
```
flex items-center gap-2.5 px-2.5 py-[7px] rounded-md text-[12.5px] font-medium
```

### Group label

`px-2.5 py-1 text-[10px] uppercase tracking-wider` muted. First group gets `mt-1`, subsequent `mt-3`.

### Nav config

The nav is data-driven — reproduce verbatim from `v2-shell.jsx` `NAV` array. Each item: `{ id, label, icon, badge?, badgeTone? }`. Badges:

- `tickets`: `7` (open count) — neutral
- `invoices`: `3` (unpaid/overdue) — neutral
- `agents`: `2` (critical findings) — `bad` tone

In Svelte, badges should be **derived from a store**, not literals. Use derived stores like `$openTickets`, `$unpaidInvoices`, `$criticalFindings`.

---

## `TopBar`

Height `54 px` (`min-height: 54px`, `py-3 px-5`). White, hairline-bottom.

```
┌────────────────────────────────────────────────────────────────────────┐
│  Billing › Invoices                                                    │  breadcrumb 11 px muted
│  Invoices  optional sub                  [⌘K trigger]  [primary CTA]   │  title 18 px 600
└────────────────────────────────────────────────────────────────────────┘
```

### Breadcrumb

`flex items-center gap-1 text-[11px]` muted, separator `›` at `opacity:.5`. Last segment is `--ink`. Above the title.

### Title row

```
flex items-baseline gap-2
  h1: text-[18px] font-semibold leading-tight
  sub: text-[12px] muted   ← optional, single line
```

The `sub` prop is the place to put metadata that used to be a "Production" badge — examples in v2:

| Page | sub |
|---|---|
| Dashboard | `Tuesday, 7 May · 4 things need you today` |
| Agents | `21 enrolled · 2 critical findings` |
| Audit | `Every state-changing action across the workspace` |
| Reports | `Last 12 months · EUR` |
| Uptime | `14 monitors · 99.94% / 30d` |

### ⌘K trigger

Pinned to the right of the title, before primary actions. Hidden below `md`.

```
button.flex.items-center.gap-2.px-2.5.py-1.5.rounded-md.border.hairline
  bg: #fbfcfd   color: var(--muted)   min-w: 240px
  ▸ search icon
  ▸ "Search or run a command…" (left-aligned, flex-1)
  ▸ kbd ⌘K (mono 10.5px in a 1px-bordered tile)
```

Click → opens the palette overlay (see below).

### Primary action(s)

Right slot. Convention:

- 1 ghost (export) + 1 primary (new …) on list pages.
- 1 primary on simple pages.
- Multiple ghosts + 1 primary on Dashboard.
- On detail pages (Agent detail), it's `<StatusPill> + Disable + Reboot + Delete`.

---

## ⌘K palette

Source: `v2-pages-misc.jsx` → `Palette` component.

### Trigger

- Global hotkey: `⌘K` / `Ctrl+K`. Bind on `window` from `+layout.svelte`.
- Topbar trigger is the same action.
- Closes on `Esc`, click-outside, or successful action.

### Layout (640 px wide, max 480 px tall body)

```
┌─ Search ───────────────────────────────┐  border-b, 12 px V padding
│  🔍   _input_                     [esc] │  14 px input, mono kbd
├─ Scopes ───────────────────────────────┤  border-b, bg #fbfcfd
│  Scope:  All  Invoices  Tickets  …     │  brand-soft chip on active
│                          ↑↓ ↵ ⌘↵ hint  │  mono right-aligned
├─ Results (scrollable) ─────────────────┤
│  CLIENTS                               │  10.5 px uppercase
│  [icon] Hörmann GmbH      3 open inv   │  highlight = brand-soft row
│  INVOICES                              │
│  [icon] Hörm…ann · INV-…   Draft · €   │
│  …                                     │
├─ Footer ───────────────────────────────┤
│  10 results          ⌘K opens anywhere │
└────────────────────────────────────────┘
```

### Scopes

`All · Invoices · Tickets · Clients · Agents · Commands`. Active chip: `brand-soft` bg, `brand-ink` text. Inactive: transparent + muted.

### Result row

```
flex items-center gap-2.5 px-3.5 py-2 text-[12.5px]
  [14 px icon]  [primary text — bold matched substring]  [trailing meta muted]
  highlight ? brand-soft bg
```

Groups: `Clients · Invoices · Tickets · Commands · Recent`.

Group label: `px-3.5 pt-2 pb-1 text-[10.5px] uppercase tracking-wider` muted.

### Substring highlight

When the search query matches part of a result label, wrap the matched span in `<b>` (no extra colour — bold is enough). The proto shows this on `Hörm` matching `Hörmann`.

### Commands

Distinct from searchable entities. Trailing meta is the keystroke (`⌘ N`, `⌘ ⇧ R`, etc.). Examples wired:

- `Create invoice for {client}` → `⌘N`
- `Roll up ticket time → invoice` → `⌘⇧R`
- `Switch workspace` → `⌘⇧O`
- `Toggle dark theme` → `(no keystroke, just the toggle action)`

### Footer hints

`↑↓ navigate · ↵ open · ⌘↵ run`. Mono, muted, in scopes row right side. Footer also has `10 results` count + `⌘K opens this from anywhere`.

### Implementation notes for Svelte

- Build `CommandPalette.svelte` as a portalled overlay using a backdrop `linear-gradient(180deg, #0c1116 0%, #1b262d 100%)` at `padding: 24` (mirrors proto).
- Index: every result is `{group, icon, label, meta, action, score}`.
- Use a fuzzy-match library (`fuse.js`) over `label + group + …`.
- Highlight matched ranges via `mark` (style with `font-weight: 600`, no bg).
- Keep the result list **virtualized** if the index gets large; for v2 a flat list is fine.
- Persist last query for 30 s after close; reset on Esc.
