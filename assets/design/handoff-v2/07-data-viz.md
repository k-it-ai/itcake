# 07 · Data viz: tables, charts, calendar, sparklines

## Tables

Universal rules:

- Body `text-[12.5px]` (or `12px` on dense pages: Agents, Audit, Uptime).
- Header `text-[10.5px] uppercase tracking-wide` muted.
- Row borders: `divide-y` with `border-color: var(--line-2)`.
- First col `pl-4`, last col `pr-4`.
- Right-align all numeric/monetary columns; tabular nums.
- Mono 11–11.5 px for IDs, hostnames, IPs, serials, timestamps.
- Action column = trailing `⋯` muted, fixed `w-8`.
- Selectable tables: leading checkbox, selected rows `bg #fef7f8` (only on destructive contexts; otherwise `bg #fbfcfd`).
- Bulk-action bar slides in over the toolbar when ≥1 selected (see Invoices spec).

## Stat cards (KPI tiles)

Two density variants in use:

| Density | Padding | Number size | Where |
|---|---|---|---|
| `lg` | 14 | 22 px | Agents stat row |
| `md` | 14 | 18–20 px | Tickets, Expenses, Uptime stat rows |
| `sm` | 14 | 15 px | Agent detail metrics row (6 across) |

Anatomy:
```
┌──────────────────────────────────┐
│ muted 11 px label                │
│ NUM (semibold, num)   [spark/dot]│
│ muted 10.5 px sub                │
└──────────────────────────────────┘
```

## Sparkline (`Spark`)

- 64 × 20 SVG, polyline only.
- Stroke 1.5, no fill.
- Default colour `--brand`, override via `color` prop.
- Auto-max from data; 2 px top/bottom padding; equal x spacing.
- Zero baseline never drawn (it's a trend, not a bar).
- Don't add tooltips, dots, or axis labels.

## Bar (`Bar`)

- Track `h-1.5 rounded-full bg #eef0f4`.
- Fill: tone-coloured (default `--brand`).
- Width `${pct}%`, no label inside.
- Pair with a number sibling (`MetricCell` shows the suffix above).

## BarChart (Reports / Revenue by month)

- 12 columns, equal flex.
- Two-segment stack: paid (`--brand`) bottom, outstanding (`--accent` at `opacity:.55`) top.
- Container 230 px tall, bars max 200 px (auto-scaled to data max).
- Bar tops `border-radius 2 px` only on the top stack.
- Month labels below in 10 px muted.
- No grid lines, no Y axis, no tooltips in v2 (add hover tooltip later — not now).

Legend in `SectionHead` right slot:
```
[10×8 brand swatch] Paid   [10×8 accent .55 swatch] Outstanding
```

## Calendar (Tickets)

Grid: `gridTemplateColumns: 56px repeat(7, 1fr)`. Two header rows (rail + day labels), then content area.

| Element | Rule |
|---|---|
| Day header | `text-[11.5px] font-medium`, today gets `bg #fbfcfd` + `Today` brand-ink label |
| Hour rail | mono 10 px muted, right-aligned `pr-2`, 28 px row height |
| Row line | `1px solid var(--line-2)` between hours |
| Column line | `border-left 1px solid var(--line-2)` |
| Event card | `absolute left-1 right-1 rounded-md px-1.5 py-1 text-[10.5px]`, soft bg + 3 px coloured left border |
| Event title | `font-semibold leading-tight truncate` |
| Event client | sibling line, `opacity:.75 truncate` |

Hours range: 08–18 (11 rows). Don't draw past business hours unless an event spills over.

## UptimeStrip

- 90 cells × 5 × 18 px, gap 1 px.
- `radius 1`.
- Default cell `#bcd7df` (faded brand).
- "No data yet" cells (e.g. cells 0–2 for new monitors) `#cfd6dd`.
- Down cells `--bad`.
- Cells are interactive: each cell is a `<button role="img" aria-label="…">` with `cursor: pointer`.

### Hovered / focused cell

- 1.5 px solid `var(--ink)` outline at `outlineOffset: 1`.
- 100 ms ease transition on `outline`. No fill change.
- Cell announces via aria-label: `"Tue 5 May 2026: up, 100%, 142 ms average response"`. Down cells: `"Mon 3 May 2026: down for 26 minutes"`. No-data cells: `"Sat 7 Feb 2026: no data — monitor not enrolled yet"`.

### Tooltip card

Anchored to the hovered/focused cell, positioned 8 px above its centre, `transform: translate(-50%, -100%)`.

- Width `220 px`, `padding 10 12`.
- `bg var(--card)` · `border 1px solid var(--line)` · `box-shadow var(--shadow)` · `radius 8`.
- `pointer-events: none` so it never traps the mouse.
- `z-index: 10` (sits above table rows but below the global palette).
- 120 ms fade-in, no translate. Reduced motion: instant.

Contents (top to bottom):

```
mono 11 px muted        Tue · 5 May 2026
13 px font-medium       Up · 100%       (color follows tone: good/ink/bad/muted)
11.5 px muted           142 ms avg · 1,440 / 1,440 checks
─── hairline ───        (only if incident)
mono 10.5 px brand      INC-2026-019 →  (link, underlined, opens incident detail)
```

Tone of line 2:
- up → `var(--ink)`
- down → `var(--bad)`
- no-data → `var(--muted)`
- degraded (future) → `var(--warn)`

### Live tail (above the strip table)

Inline status row spanning the full table width, rendered in a flush `Card` directly above the monitor list. It mirrors whatever cell the cursor / focus is on. When nothing is hovered, it shows a default "today, all up" summary.

Layout (`flex items-center gap-3 px-4 py-2.5 text-[12px]`):

| Slot | Width | Style | Contents |
|---|---|---|---|
| Date | 160 px | mono 11 muted | `Tue · 5 May 2026` (or `Today · 7 May 2026` default) |
| Monitor | 200 px | mono 11.5 medium | `staging.itcake.app` (or `Hover a cell` default) |
| Status | auto | `<Tag tone="…">` | `Up · 100%` / `Down` / `No data` / `All up` |
| Avg | auto | num muted | `142 ms avg` |
| Detail | flex-1 | muted | `1,440 / 1,440 checks` / `TLS cert renewal failed` / `across 14 monitors` |

Why this exists: small screens / pointer-coarse devices where a tooltip is awkward, and to give an at-a-glance summary while the user scans the strip without committing to a hover.

### Keyboard

- Cells are tab-stops. `Tab` walks left→right within a strip; the next `Tab` jumps to the next monitor's strip.
- `←/→` move the focused cell within a strip without leaving it (custom handler).
- `Enter` on a down cell opens the linked incident.

### Implementation hint

In Svelte, hoist hover state to the `UptimePage` component and pass `(monitorIdx, cellIdx, isDown) ⇒ void` down to each `<UptimeStrip>`. Render a single tooltip + single live-tail row at the page level — don't put a tooltip per strip.

## Toggle pill (Auto-update)

- Track 30 × 16, `border-radius 99`. Off `#cfd6dd`, on `--brand`.
- Knob 12 × 12 white, 2 px padding, justified by state.
- Animate `transform` 150 ms ease.

## Rules across all viz

- Text size **never below 10 px**. If labels don't fit, drop labels — don't shrink.
- Tone usage: data series in `--brand` first, `--accent` second. Reserve `--good/warn/bad` for severity, not raw data series.
- No drop shadows on data shapes. No 3-D, no gradients.
- Empty viz: render the chrome (axis, header) and a `stripes` overlay where the data would be — never hide the card.
