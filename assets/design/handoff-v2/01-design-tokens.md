# 01 · Design tokens

All tokens live as CSS custom properties on `:root` in `itcake-redesign-v2.html` (lines 15–39). Port them verbatim to `src/app.css`.

## Surface

| Token | Hex | Usage |
|---|---|---|
| `--bg` | `#f6f7f9` | Default page background (inside the frame, behind cards) |
| `--card` | `#ffffff` | Card background |
| `--ink` | `#0c1116` | Primary text |
| `--muted` | `#5b6470` | Secondary text, labels, table column headers, breadcrumb (non-current) |
| `--line` | `#e6e9ee` | Outer hairline (around cards, frame outer borders) |
| `--line-2` | `#eef0f4` | Inner hairline (table rows, divider inside cards, calendar grid) |

The page **outside** the frame is `#eaecef` (set on `html, body`) — gives the design canvas a visible chrome edge so the white app stands out.

## Brand

| Token | Hex | Usage |
|---|---|---|
| `--brand` | `#0e7c9c` | Primary brand cyan-teal — used for primary buttons, focus rings, sparkline strokes, active progress bars |
| `--brand-2` | `#5cd2ee` | Brand accent / highlight (sidebar active text, brand mark fill on dark) |
| `--brand-ink` | `#063847` | Brand text on light brand surfaces (chips, soft buttons, brand pills) |
| `--brand-soft` | `#e6f3f8` | Brand soft fill — chips, active sub-tabs, selected list rows |

## Severity (the only legal status colours — see `06-status-system.md`)

| Token | Hex | Soft | Usage |
|---|---|---|---|
| `--good` | `#1f8a5b` | `--good-soft #e3f3eb` | Healthy, paid, online, pass |
| `--warn` | `#a85a00` | `--warn-soft #fbeed7` | Stale, near-due, medium severity |
| `--bad`  | `#a8232c` | `--bad-soft  #fae3e5` | Overdue, offline, critical |
| `--accent` | `#b06c00` | `--accent-soft #fbf1de` | "Attention but neutral" — recurring, scheduled, viewed-not-acted |

Soft fills pair with darker, hand-picked text colours (defined in components, not as tokens):

| Tone | Soft bg | Text |
|---|---|---|
| `good` | `var(--good-soft)` | `#0f5d3d` |
| `warn` | `var(--warn-soft)` | `#7a4400` |
| `bad`  | `var(--bad-soft)`  | `#7a1a22` |
| `accent` | `var(--accent-soft)` | `#7a4a00` |
| `brand`| `var(--brand-soft)`| `var(--brand-ink)` |
| `neutral` | `#eef0f4` | `#3a424c` |
| `ink` (inverted) | `#0c1116` | `#fff` |

## Sidebar (dark)

| Token | Hex | Usage |
|---|---|---|
| `--nav` | `#0f1418` | Sidebar background |
| `--nav-line` | `#22282f` | Sidebar borders (user pod, dividers) |
| `--nav-mute` | `rgba(255,255,255,.55)` | Group labels, secondary text |
| `--nav-active` | `#11353f` | Active nav item background |
| `--nav-active-text` | `#5cd2ee` | Active nav item text + icon |
| Inactive item text | `#dde3ea` (literal) | |
| Inactive item icon | `opacity .8` of text | |

Badge backgrounds inside nav:

- Default: `rgba(255,255,255,.10)` bg, `#cfd6dd` text
- `bad` tone: `rgba(168,35,44,.22)` bg, `#ff8f96` text

## Effects

| Token / class | Definition | Usage |
|---|---|---|
| `.shadow-card` | `0 1px 2px rgba(15,20,25,.04), 0 1px 1px rgba(15,20,25,.03)` | Default card shadow |
| `.shadow-pop`  | `0 6px 24px rgba(15,20,25,.08), 0 2px 6px rgba(15,20,25,.05)` | ⌘K palette, popovers, modals |
| `.stripes`       | 135° striped overlay at 4.5% black | Diagonal-fill empty/skeleton states |
| `.stripes-brand` | 135° striped overlay at 8% brand | Brand-tinted skeletons |

## Radii

The design uses three radii consistently:

| px | Used for |
|---|---|
| `4` (`rounded-sm`) | Sparkline bar tops, calendar event chips |
| `6` (`rounded-md`) | Buttons, filter chips, segment switchers, input fields |
| `8` (`rounded-lg`) | Cards, ⌘K palette container |
| `999` (`rounded-full` / `rounded-pill`) | Tags, status pills, dots, avatars circular |

## Spacing rhythm

The frame uses a **4 / 8 / 12 / 14 / 16 / 20 / 24** scale. Most cards have `padding: 14`; reports/settings use `padding: 16` or `20` for breathing room. Stat-row cards always `14`.

| Where | Padding |
|---|---|
| Frame body | `20` (`p-5`) |
| Card default | `14` |
| Card "feature" (Reports rev chart, Settings panes) | `16`–`20` |
| Card flush (`padding={0}`) | `0` — used when the card hosts a table or filter row |
| Filter row inside flush card | `12 12` (`px-3 py-2`) |
| Table cell vertical | `8`–`10` (`py-2` / `py-2.5`) |
| Table cell first col | `pl-4`; last col `pr-4` |

## Tailwind mapping

Add to `tailwind.config.js`:

```js
extend: {
  colors: {
    bg:       'var(--bg)',
    ink:      'var(--ink)',
    muted:    'var(--muted)',
    brand:    'var(--brand)',
    'brand-2':'var(--brand-2)',
    'brand-ink':'var(--brand-ink)',
    'brand-soft':'var(--brand-soft)',
    good:     'var(--good)',
    warn:     'var(--warn)',
    bad:      'var(--bad)',
    accent:   'var(--accent)',
  },
  borderColor: { DEFAULT: 'var(--line)', '2': 'var(--line-2)' },
  boxShadow: {
    card: '0 1px 2px rgba(15,20,25,.04), 0 1px 1px rgba(15,20,25,.03)',
    pop:  '0 6px 24px rgba(15,20,25,.08), 0 2px 6px rgba(15,20,25,.05)',
  },
}
```
