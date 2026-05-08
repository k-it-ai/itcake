# 09 · Accessibility, keyboard, motion

## Keyboard

| Key | Action | Where |
|---|---|---|
| `⌘K` / `Ctrl+K` | Open palette | global |
| `Esc` | Close palette / modal / popover · clear bulk selection · cancel inline edit | global |
| `↑ ↓` | Move highlight in palette / lists | palette, tables |
| `↵` | Open highlighted result · activate primary | palette, lists |
| `⌘↵` | Run command (palette) · save (forms) | palette, settings |
| `⌘N` | New (entity) | invoices, tickets, agents… |
| `⌘⇧R` | Roll up tickets → invoice | dashboard, tickets |
| `⌘⇧O` | Switch workspace | global |
| `?` | Open keyboard shortcuts modal | global |
| `Tab` / `Shift+Tab` | Standard focus traversal | everywhere |

All interactive elements must be reachable by Tab, including filter chips, status pills, calendar event cards, agent rows.

## Focus styles

```css
:focus-visible {
  outline: 2px solid var(--brand);
  outline-offset: 1px;
  border-radius: inherit;
}
```

Don't suppress outlines. The proto omits them; add them in the production app.

## ARIA & semantics

- `Frame` → `<main>` for the body, `<nav aria-label="Primary">` for the sidebar, `<header>` for the topbar.
- `StatusPill` with chevron → `<button aria-haspopup="menu">` because it opens a status menu.
- Tabs → `role="tablist"` / `role="tab"` / `role="tabpanel"` with `aria-selected` and `aria-controls`.
- Filter chips → `<button aria-pressed>` when active.
- ⌘K palette → `role="dialog" aria-modal="true" aria-label="Command palette"`. Result list `role="listbox"`, results `role="option" aria-selected`.
- Tables: keep semantic `<table><thead><tbody>`. Sortable columns add `aria-sort="ascending|descending|none"` on `th`.
- Bulk-action bar announces `2 selected · €6,140.00 outstanding` via `role="status" aria-live="polite"`.
- Sparklines, BarChart, UptimeStrip: wrap in `role="img"` with `aria-label="…"` summarising the data ("Revenue trend, 18 points, ranging €600 to €1,800, last value €1,505").

## Color contrast (WCAG AA targets)

Verified at AA on white bg:

| Pair | Ratio |
|---|---|
| `--ink` on `--card` | 17.8 |
| `--muted` on `--card` | 5.4 ✓ |
| `--brand` on white | 4.7 ✓ |
| `--brand-ink` on `--brand-soft` | 9.2 ✓ |
| White on `--brand` | 4.5 ✓ |
| `--bad` on white | 5.6 ✓ |
| White on `--bad` | 5.6 ✓ |
| `#7a1a22` on `--bad-soft` | 8.1 ✓ |
| `#0f5d3d` on `--good-soft` | 7.6 ✓ |

**Re-verify after any token change.**

## Motion

Default duration `150 ms`, easing `ease`. Larger surfaces (palette, modal) `200 ms ease-out`.

| Surface | Animation |
|---|---|
| Palette open | fade + 8 px upward translate, 200 ms |
| Toggle pill | knob `transform` 150 ms |
| Filter chip / button | none on hover (colour shift only) |
| Table row hover | none — just `bg #fbfcfd` |
| Tab change | underline `transform`, 180 ms |
| Bulk bar slide | `translateY(-100%) → 0`, 180 ms |
| Skeleton | 1.6 s linear infinite shift |

Respect `prefers-reduced-motion: reduce` — disable skeleton shift, palette translate, bulk-bar slide.

## Hit targets

Minimum tap target 32 × 32. Buttons satisfy this with `py-1.5` (24 px text + 6 padding); `sm` ghost icons sit at 24 — give them a transparent `padding: 4` to expand the hit area without changing visuals.

## Screen-reader-only utilities

```css
.sr-only {
  position: absolute; width: 1px; height: 1px;
  padding: 0; margin: -1px; overflow: hidden;
  clip: rect(0,0,0,0); white-space: nowrap; border: 0;
}
```

Use on:
- Sort direction labels in table headers ("sorted ascending").
- Spark/Bar `aria-label`s when a visible label is impractical.
- Icon-only buttons (`<button><Icon/><span class="sr-only">Delete</span></button>`).

## Internationalisation

- All copy ships through `paraglide` / `svelte-i18n`. Don't hard-code in components.
- Numbers via `Intl.NumberFormat(locale, …)`.
- Dates via `Intl.DateTimeFormat` or `date-fns/locale`.
- Pluralisation: ICU MessageFormat for `{count, plural, one {…} other {…}}`.
- RTL not supported in v2 (no Arabic/Hebrew clients in scope) — but don't bake `left/right` into layouts; use `start/end` where possible to keep the door open.
