# 06 · Status & severity system

The whole app uses **one** five-tone system. Anywhere you're tempted to invent a colour, stop and pick one of these.

| Tone | Meaning | Where it appears |
|---|---|---|
| `good` | Healthy, paid, online, pass, billable | Invoice paid, agent online, monitor up, CIS pass, KPI ▲ |
| `brand` | Active / informational / verb | Sent invoice, open ticket, audit verb chip, active filter chip, primary action |
| `accent` | Attention but neutral | Recurring, scheduled, viewed-not-acted, calendar accent events |
| `warn` | Stale / near-due / medium severity | Stale agent, near-overdue, medium finding, missing receipt |
| `bad` | Broken / overdue / critical | Overdue, offline, critical finding, incident, KPI ▼ |
| `neutral` (untoned) | No state | Cancelled, default tags, generic chips |

## Mapping by domain

| Entity | States → Tone |
|---|---|
| Invoice | draft→neutral · sent→brand · overdue→bad · paid→good · cancelled→neutral |
| Ticket | open→brand · scheduled→accent · completed→good · invoiced→accent · cancelled→neutral |
| Proposal | draft→neutral · sent→brand · viewed→accent · accepted→good · expired→bad |
| Agent | online→good · stale→warn · offline→bad |
| Finding | crit→bad · high→bad · med→warn · low→neutral |
| Monitor | up→good · down→bad · degraded→warn |
| Posture control | pass→good · warn→warn · fail→bad |
| Receipt | present→good (`✓ PDF`) · missing→warn |
| KPI delta | positive in revenue/billable→good · negative in expenses→good · negative in revenue→bad |

## Visual carriers

A status appears in three forms; pick the right one:

1. **`Dot`** — when the badge would be redundant (column already says "online"). 8 px filled circle.
2. **`Tag`** — short noun/category. Soft-fill pill.
3. **`StatusPill`** — interactive, click-to-change with the chevron. The default for any "live" state column.

Don't combine all three on the same row. Pick one carrier per state.

## Don'ts

- ❌ No purple/pink/yellow alerts. Five tones, period.
- ❌ No gradient pills.
- ❌ No emoji as severity (`🚨`, `⚠️`). The system has icons + colour for that.
- ❌ No coloured row backgrounds **except** the bulk-action `#fef7f8` in invoices (signals a destructive multi-select).
