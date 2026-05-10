# 03 · Primitives

Every primitive lives in `v2-primitives.jsx`. Each section below: visual spec → variants → Svelte port notes. Build all of these as `src/lib/components/ui/*.svelte` **before** any page.

---

## `Tag`

A small inline pill for taxonomy / status labels.

- Shape: `inline-flex items-center rounded-full px-2 py-[2px] text-[11px] font-medium num`.
- Tones: `neutral` (default) · `brand` · `good` · `warn` · `bad` · `accent` · `ink` (inverted, dark fill on light bg).
- Color matrix: see `01-design-tokens.md` → soft fill + matching ink.

```svelte
<Tag tone="bad">3 crit</Tag>
```

---

## `Dot`

8 px filled circle, used as a status indicator before text. Same tone vocabulary minus `accent` and `ink`; adds `mute` (`#9aa3ad`).

```svelte
<Dot tone="good" />
```

Hex per tone (these are slightly more saturated than the soft-fill text colours; they're the **dot-only** scale):

| Tone | Hex |
|---|---|
| good | `#1f8a5b` |
| brand | `#0e7c9c` |
| warn | `#a85a00` |
| bad | `#a8232c` |
| mute | `#9aa3ad` |

---

## `StatusPill`

Tag + leading dot + trailing chevron. Used as the **canonical state badge** (Invoice status, Agent online/offline, Uptime up/down). Default `withDot=true`, `action=true` (chevron implies it's a click-to-change menu trigger).

```svelte
<StatusPill tone="bad">overdue</StatusPill>
```

Tones map identically to `Tag`. The chevron is the 12 px `I.chev` SVG at `opacity:.55`.

When **no menu is wired** behind it (e.g. a read-only status), pass `action={false}` to drop the chevron — and prefer `Tag` instead.

---

## `Pin`

Numbered badge: 18 px circle, `--brand` bg, white `10px 700`. Used in the dashboard Inbox and the Review artboard to show priority order. Tone variations override background only (set inline via `style={{background:…}}`).

---

## `Btn`

Single button atom. Variants:

| Variant | Bg | Text | Border |
|---|---|---|---|
| `primary` | `--brand` | `#fff` | `--brand` |
| `soft` | `--brand-soft` | `--brand-ink` | `#c8e2ec` |
| `ghost` | transparent | `--ink` | `--line` |
| `danger` | `--bad` | `#fff` | `--bad` |
| `dangerSoft` | `--bad-soft` | `#7a1a22` | `#f0c8cc` |
| `warnSoft` | `--warn-soft` | `#7a4400` | `#f0d8a0` |

Sizes: `md` (default, `px-2.5 py-1.5 text-[12.5px]`), `sm` (`px-2 py-1 text-[11.5px]`).

Layout: `inline-flex items-center gap-1.5 rounded-md font-medium`. Optional `icon` slot before children.

**Hover/focus** (not in proto, add in Svelte):

- Hover: bg shifts ~6 % darker (use `oklch` calc or hand-tune).
- Focus visible: `outline: 2px solid var(--brand); outline-offset: 1px`.
- Disabled: `opacity .5; cursor: not-allowed`.

---

## `FilterChip`

`label · value · ▾` chip used in toolbars. Active state uses brand soft fill + `#c8e2ec` border.

```svelte
<FilterChip label="Status" value="Open" active />
```

Spec: `inline-flex items-center gap-1.5 pl-2 pr-1.5 py-1 rounded-md text-[12px]`. Label is `--muted`, value is `--ink` (or `--brand-ink` when active), chevron is muted.

---

## `Card`

Container. `rounded-lg`, white, 1 px hairline, `shadow-card`. Default `padding: 14`. Two opt-outs:

- `padding={0}` ("flush") — when the card hosts a table or filter row that defines its own gutters.
- Numeric override (e.g. `padding: 16`, `padding: 20`) — used by Reports cards and Settings panes.

`className` is forwarded so callers can pass `col-span-N` etc.

---

## `SectionHead`

Pair of title + sub + optional right-rail content. Goes inside a card top-edge.

```svelte
<SectionHead title="Boot performance" sub="Last 14 days · 22.4s average" right={…} />
```

Title: `text-[13px] font-semibold`. Sub: `text-[11.5px]` muted. Layout: `flex items-baseline justify-between mb-2`.

---

## `Bar`

Inline progress bar — used in agent list (CPU/mem/disk) and reports (top clients).

- Track: `h-1.5 rounded-full bg #eef0f4`
- Fill: `--brand` (or per-tone `good/warn/bad`)
- Width: `pct%`, no animation in proto (add `transition: width 200ms ease` in Svelte).

---

## `Spark`

20 × 64 SVG line. Polyline only, `stroke-width: 1.5`, no fill, no dots, no axis.

Default colour: `--brand`. Pass `color` and `data` (array of numbers).

For Svelte, build a tiny utility that:

- Auto-computes `max` from data (no zero baseline).
- Pads top/bottom by 2 px.
- Returns a `<polyline>` with computed points.

---

## `Avatar`

Square (4 px radius) tile with initials. Sizes: 20, 22, 24, 28 (most common).

Background `#eef0f4`, text `#3a424c` weight 600. Initials = first letter of first two whitespace-separated tokens, uppercase. Truncate to two characters; never single character.

In production, swap for image when present, fall back to initials.

---

## `I` icon set

`v2-primitives.jsx` defines 12 inline icons; `v2-shell.jsx` defines 12 nav icons. All:

- 24 × 24 viewBox
- 14 px or 16 px display size
- `stroke="currentColor" stroke-width="1.6–2" fill="none"`
- `stroke-linecap=round stroke-linejoin=round` on nav icons (consistency with body icons)

| Inline (`I.…`) | Nav (`navI()`) |
|---|---|
| search · plus · bolt · chev · more · arrow · check · x · download · pdf · paperclip · euro | home · ticket · doc · proposal · receipt · users · grid · chart · cube · pulse · history · cog |

For Svelte, replace with **lucide-svelte** equivalents — they're 1:1 mappings:

| Custom | Lucide |
|---|---|
| `I.search` | `Search` |
| `I.plus` | `Plus` |
| `I.bolt` | `Zap` |
| `I.chev` | `ChevronDown` |
| `I.more` | `MoreHorizontal` |
| `I.arrow` | `ArrowRight` |
| `I.check` | `Check` |
| `I.x` | `X` |
| `I.download` | `Download` |
| `I.pdf` | `FileText` |
| `I.paperclip` | `Paperclip` |
| `I.euro` | `Euro` |
| `home` | `Home` |
| `ticket` | `Ticket` |
| `doc` | `FileText` |
| `proposal` | `FileSignature` |
| `receipt` | `Receipt` |
| `users` | `Users` |
| `grid` | `LayoutGrid` |
| `chart` | `BarChart3` |
| `cube` | `Box` |
| `pulse` | `Activity` |
| `history` | `History` |
| `cog` | `Settings` |

Use `size={14}` (inline) or `size={16}` (nav). Pin `stroke-width={1.6}` globally for visual match.

---

## Internal-only helpers (not Svelte-exported)

These are tiny one-liners used inside one or two pages. Reproduce inline in their host component:

- `MetricCell` (Agents list, agent detail)
- `Findings` (Agents list)
- `Row` (Agent detail "Hardware warranty")
- `UptimeStrip` (Uptime)
- `InvStatus` (Invoices) — wrapper around StatusPill
- `Field` (Settings)
- `Group`, `Item` (⌘K palette)
- `Calendar` (Tickets)
- `BarChart` (Reports)
- `Section`, `Group` in ReviewArtboard (n/a in production)

If two pages use the same one verbatim, hoist to `lib/components/_internal/`.
