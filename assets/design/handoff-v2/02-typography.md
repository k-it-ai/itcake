# 02 · Typography & numerics

## Families

```html
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&family=JetBrains+Mono:wght@400;500&display=swap" rel="stylesheet">
```

| Family | Stack | Use |
|---|---|---|
| **Inter** | `'Inter', ui-sans-serif, system-ui, sans-serif` | All body text, headings, UI labels |
| **JetBrains Mono** | `'JetBrains Mono', ui-monospace, monospace` | IDs (INV-…, T-…, agent hostnames, tokens, IPs, serials, timestamps) |

(Existing handoff suggested Geist Mono; v2 uses **JetBrains Mono**. Use whichever matches your source — Geist is fine as a near-equivalent.)

## Type scale

All sizes are absolute (px), set via Tailwind arbitrary values like `text-[12.5px]`. **No `rem` step ladder** — densities differ between contexts and the px scale is canonical.

| Use | Size | Weight | Letter / line |
|---|---|---|---|
| Page H1 (topbar) | `18px` | 600 | tight |
| Card header / `SectionHead` title | `13px` | 600 | normal |
| Card sub | `11.5px` | 400 | normal, `--muted` |
| Body / table cell | `12.5px` | 400 | normal |
| Compact body (agent list, calendar list rows) | `12px` | 400 | normal |
| Small label / row meta | `11.5px` | 400 | `--muted` |
| Tiny meta (sublabels, footer hints) | `11px` | 400 | `--muted` |
| Table column header | `10.5px` | 400 | `uppercase tracking-wide`, `--muted` |
| Group label (sidebar, ⌘K group, settings list) | `10px–10.5px` | 400 | `uppercase tracking-wider`, muted |
| Stat number (small) | `15–18px` | 600 | tabular |
| Stat number (large hero) | `22–28px` | 600 | tabular, `tracking-tight` |
| Mono ID | `11–11.5px` | 400 (or 500 for filenames) | mono |
| Tag / pill | `11px` | 500 | tabular nums |

## Numerics

Always use tabular numerals on:

- Money columns (`text-right num font-medium`)
- Hours/durations
- Counts in stat cards / badges
- Timestamps in calendar / audit log
- Sparkline labels

CSS:
```css
.num { font-variant-numeric: tabular-nums; }
```

In Svelte, pass through as a class. Do **not** mix proportional and tabular figures in the same column — it ruins right-alignment.

## Money formatting

| Locale | Format | Example |
|---|---|---|
| Display (DE)  | `de-DE`, currency | `€1.320,00` (current proto uses `€1,320.00` US-style — the actual DE app should use `Intl.NumberFormat('de-DE', { style:'currency', currency:'EUR' })`) |
| Internal | minor units (cents) integer | `132000` |

The prototype uses US-style commas because the audience reads either; the Svelte app should localise. Either way, **right-align** monetary cells and use tabular figures.

## Special character conventions

- Middle dot `·` (U+00B7) separates inline meta: `Sent 26 Apr · viewed 4×`. Surround with single spaces.
- Em dash `—` (U+2014) for "no value" cells: `—`.
- Right-arrow `→` for transitions in audit diffs and "convert" CTAs.
- `▲` `▼` for KPI deltas, paired with `tone="good"` / `tone="bad"`.
- Multiplication sign `×` for counts: `viewed 4×`, `42×`.

## Truncation rules

- Hostnames, IDs, filenames: `mono`, single line, `truncate` with ellipsis. Tooltip on hover shows full value.
- Client / vendor names in tables: ellipsis with min-width `0`.
- Dashboard inbox titles: 1 line ellipsis; sub gets 1 line ellipsis too.
- Calendar event labels: 1 line title + 1 line client, `opacity .75` on client.

## Headings system summary

There is **no h2/h3/h4 ladder** like a marketing page. The shell provides the page title (h1 in topbar). Inside the frame, "headings" are just `text-[13px] font-semibold` `SectionHead`s — they title cards. Don't add bigger inline section headers.
