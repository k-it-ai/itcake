# 08 · Empty, loading, error states

Each list / detail surface needs three non-happy states. The proto only shows the happy path; specs below are the contract.

## Empty

Rendered inside the same card chrome as the populated state.

```
┌─ Card ─────────────────────────────────┐
│  [icon 24, --muted]                    │
│  Headline (13 px font-semibold)        │
│  Sub (11.5 muted, 1–2 lines)           │
│                                        │
│  [primary CTA] [optional secondary]    │
└────────────────────────────────────────┘
```

- Padding: `py-10 px-6` for in-card empties; full-page empty centers in the body.
- Icon: matches the entity's nav icon (e.g. `cube` for agents, `doc` for invoices).
- CTA: the same button you'd find in the topbar `right` slot of that page.

Per-page copy:

| Page | Headline | Sub | CTA |
|---|---|---|---|
| Invoices | "No invoices yet" | "Create your first invoice or roll up unbilled tickets." | `New invoice` · `Roll up tickets` |
| Tickets | "No tickets in this period" | "Adjust the filter or log a new ticket." | `New ticket` |
| Agents | "No agents enrolled" | "Run the install one-liner on a device to see it here within seconds." | `Enroll agent` |
| Uptime | "No monitors yet" | "Add an HTTPS, SMTP or TCP target to begin tracking uptime." | `New monitor` |
| Proposals | "No proposals" | "Send a proposal to start the pipeline." | `New proposal` |
| Expenses | "No expenses for this period" | "Email receipts to inbox@example.com or add one manually." | `New expense` |
| Catalog | "Catalog is empty" | "Add the services and products you bill for." | `New item` |
| Reports | "Not enough history yet" | "Reports populate after the first paid invoice." | (none) |
| Audit | "No events match these filters" | "Try expanding the range or clearing actor/resource." | `Clear filters` |
| Search ⌘K | "No results in {scope}" | "Try a different scope, or check spelling." | (none) |

## Loading

Two patterns:

### Skeleton rows (lists)

Replace data rows with the same row scaffolding but cells filled with a `stripes` block:

```css
.skeleton {
  background-image: repeating-linear-gradient(135deg,
    rgba(12,17,22,.045) 0 6px, transparent 6px 12px);
  border-radius: 4px;
  height: 12px;
  width: var(--skel-w, 60%);
  animation: skeletonShift 1.6s linear infinite;
}
@keyframes skeletonShift { from{background-position:0 0} to{background-position:24px 0} }
```

- Show 6 rows for tables, 4 for short lists.
- Header row stays real (always known).
- Toolbar / filters stay real but disabled (`opacity .5`, no cursor).

### Inline spinner (buttons)

When a button is in-flight, swap its label for a 12 px spinner + the verb-in-progress (`Sending…`, `Saving…`). Keep the button width stable: pre-measure or use `min-width`.

Spinner: 12 × 12 SVG, `currentColor` 1.6 stroke, animate `rotate 0.7s linear infinite`.

## Error

Two patterns: inline (per-card) and page-level.

### Inline (per card)

Same chrome as empty, but icon = `<Tag tone="bad">!</Tag>` and copy:

```
"Couldn't load {entity}"
"{server message}"
[Retry] (ghost)  [Open status](underline)
```

### Page-level (whole frame fails)

Replace the body slot with a centred panel:

```
┌────────────────────────────────────────┐
│  ✕  Couldn't load this page            │
│                                        │
│  We hit an unexpected error.           │
│  {error.message — mono, --muted}        │
│                                        │
│  [Retry]  [Open audit log]             │
└────────────────────────────────────────┘
```

Background `--bg`, no card. Error copy never reveals stack traces; log them.

## Permission-denied

Same shape as page-level error; icon `lock`, copy:
"You don't have access to {area}." · "Ask your workspace owner to grant the {role} role." · `[Open members & roles]`.

## Network offline

Top-of-frame ribbon (above breadcrumb), `bg var(--warn-soft)`, `color #7a4400`, `text-[12px] py-1 px-5`:

> Working offline · last synced 2 min ago.

When reconnecting, ribbon flips to `var(--good-soft)` for 1.5 s ("Back online · syncing 4 changes…") then disappears.
