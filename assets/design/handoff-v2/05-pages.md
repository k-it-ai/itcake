# 05 · Page specs

One section per page. Each: **purpose · layout grid · components · interactions · data deps**. The number after each page name is the artboard size in `itcake-redesign-v2.html` — keep that aspect ratio in mind when implementing.

---

## Dashboard · `/` · 1320 × 940

**Purpose** — operator's morning surface. Answers "what does ITCake need from me today?" before any vanity numbers.

**TopBar:** title `Good morning, Jana` · sub `Tuesday, 7 May · 4 things need you today` · right `[Export][New invoice]`. *No breadcrumb.*

**Body — three rows:**

### Row 1 (12-col grid, gap-4)

- **Inbox card · `col-span-7`, flush.** Card head: title `Inbox` + sub `Things ITCake is asking you to decide`, right: two `FilterChip`s (`Show=Today` active, `Owner=Anyone`). Body = list of decisions, each row:
  - `Pin` (numbered, tone-coloured: bad / warn / brand)
  - title (font-medium) + sub (11.5 muted)
  - 2 CTAs right-aligned: first `soft`, second `ghost`
  Footer: `4 of 4 shown · oldest 12d, newest 2h` + underline `Snooze rules…` link.
  Decisions are deterministic: `(overdue invoice) > (critical agent finding) > (proposal expiring) > (uninvoiced ticket bundle)`.
- **Right column · `col-span-5`** = stack of two cards:
  - **Revenue · this month** (flush). Hero: `€18,420` (28 px, semibold, tracking-tight, num) · `Tag tone="good">▲ 12.4%`. Right-rail Spark of 18 points. 3-cell footer (`Outstanding / Overdue / Draft`) divided by hairline-2 verticals; Overdue uses bad text.
  - **On the calendar today** (flush). 3-row list: time (mono, 88 px wide, muted) · title · `Tag` (tone good for billable, neutral for internal).

### Row 2 — stat strip (`grid-cols-6 gap-3`)

Six `Card`s each: muted label · big num · spark or tone dot · sub. Cards:
- Hours · this week — `21.5` + spark
- Hours · this month — `82.0`
- Earnings · week — `€1,505`
- Earnings · month — `€5,740`
- Agents online — `18 / 21` + warn dot · sub `2 critical`
- Uptime · 30d — `99.94%` + good dot · sub `1 incident`

### Row 3 (`col-span-7 / col-span-5`)

- **Ready to invoice** (flush). Head: title + `[Roll up 8.5h →]` soft btn with euro icon. Table: ticket (mono) · client · date (muted) · hours (right num) · amount (right num font-medium). 3 rows.
- **Fleet · 21 agents** (flush). Head: title + `Open agents` underline link. Inside: 3-up status mini-cards (`good 18 / warn 1 / bad 2`). Then list of 4 agents: dot · mono name · OS · optional `Tag tone="bad">N open`.

**Data deps:** `inbox`, `kpi.revenue.month`, `agenda.today`, `kpi.{hoursWeek,hoursMonth,…}`, `tickets.unbilled`, `agents.fleet.summary`, `agents.recent[4]`.

---

## Invoices · `/invoices` · 1320 × 940

**TopBar:** breadcrumb `Billing › Invoices` · right `[Export ZIP][Templates][New invoice]`.

**Body** = single card.

### Tabs row (saved views)

`flex items-center gap-1 px-2 pt-2 border-b hairline-2`. Tabs are buttons with `border-b-2` underline:
- `All · 142`
- `Drafts · 3`
- `Sent · 12`
- `Overdue · 4` *active, bad-tone underline*
- `Paid · 30d · 18`
- `Recurring · 6`

Right side: filter chips (`Date=Last 90d`, `Client=All`, `Owner=Me`) + `[＋ Add filter]` ghost.

### Bulk action bar (visible when ≥1 row selected)

Slides into the top of the body, `bg #fbf2f3` (bad-soft tint). Layout: checked checkbox · `2 selected · €6,140.00 outstanding` · right cluster `Send reminder / Mark paid / Download PDF / Cancel(dangerSoft)`.

### Table

Header (10.5 uppercase muted): `Number · Client · Issued · Due · Amount(right) · Status · ⋯`. Row spec:
- checkbox (selected rows tint `#fef7f8`)
- `Number` mono 11.5
- `Client` font-medium
- `Issued / Due` muted; **Due** uses `--bad` text + `· {age}` suffix when overdue
- `Amount` right num font-medium
- `Status` → `<InvStatus>` = `StatusPill` mapping `draft→neutral, sent→brand, overdue→bad, paid→good, cancelled→neutral`
- `⋯` more icon, muted

### Footer summary

4-cell strip in a `bg #fbfcfd` row: `Outstanding · Overdue (bad) · Paid · 90d · Avg days to pay`. Each cell: muted label + 14 px semibold num.

---

## Tickets · `/tickets` · 1320 × 1080

**TopBar:** breadcrumb `Service desk › Tickets` · right `[Roll up to invoice][New ticket]`.

### Stat row (4 cards)

`Hours · this week / Hours · this month / Earnings · week / Earnings · month`. Each: muted label · 20 px num · spark inline-right · 10.5 muted sub.

### List card (flush)

Toolbar: 4 `FilterChip`s (`Status=Open · Client=All · Tag=Any · Period=This week`) · right segmented switcher `[List | Calendar]` (active = brand-soft).

Table: `Ticket(mono) · Title · Client · When · Hours(right) · Amount(right) · Status · ⋯`. Status tones: open=brand, completed=good, invoiced=accent.

### Calendar card (flush)

Head: `Calendar · Mon 4 May – Sun 10 May, 2026` + view switcher `[Day | 3-day | Week]` (Week active) + small `‹ Today ›` mini-controls.

Grid: `gridTemplateColumns: 56px repeat(7,1fr)`. Hour rail uses 28 px row height, hours 08:00–18:00 (11 rows). Today column gets a `#fbfcfd` tint and a small `Today` brand-ink label in its header.

Events absolute-positioned per column. Tones:
- `brand` (billable): `bg var(--brand-soft)`, fg `var(--brand-ink)`, left border `3px solid var(--brand)`
- `accent` (recurring): bg `var(--accent-soft)`, fg `#7a4400`, border `var(--accent)`
- `mute` (internal): bg `#eef0f4`, fg `#3a424c`, border `#9aa3ad`

Event card: `font-semibold leading-tight truncate` title + `opacity:.75` client line.

---

## Agents · `/agents` · 1320 × 940

**TopBar sub:** `21 enrolled · 2 critical findings`. Right: `[Group by tag][Enroll agent]`.

### Stat row (4 cards)

`Online 18 (good) · Stale 1 (warn) · Offline 2 (bad) · Open findings 7 (bad) · sub "2 critical · 5 medium"`. Each card: dot + label · 22 px num.

### Agents table (flush card)

Toolbar: filters `Status / OS / Tag / Findings`, right meta `21 agents · live`.

Header columns: `Agent · OS · IP · CPU · Memory · Disk · Uptime · Findings · Last seen · ⋯`.

Row: dot (status) + mono name (`font-medium`); OS muted; IP mono 11; CPU/Mem/Disk = `MetricCell` (= `Bar` + label, tone shifts warn/bad past 80/90%); Uptime mono num muted; Findings = `<Findings>` chips: `N crit (bad) · N med (warn) · N low (neutral)`. Last-seen muted; bad text when offline.

### `MetricCell` rules

- `bad` when pct ≥ 90
- `warn` when pct ≥ 80 (or `warnAt` prop, used for disk at 70)
- `brand` otherwise

---

## Agent detail · `/agents/[id]` · 1320 × 1320

**TopBar:** breadcrumb `Operations › Agents › macbook-jana-13` · sub `MacBook Pro M3 · macOS 14.4 (arm64) · 10.0.1.42 · Apple silicon` · right `<StatusPill tone="good">online</StatusPill> [Disable][Reboot warnSoft][Delete dangerSoft]`.

### Metrics row (6 cards)

CPU · Memory · Disk · Load avg · Uptime · Last seen. Each: muted label · 15 px num · optional spark or tone dot.

### Tab strip

`border-b hairline-2 flex items-center gap-0.5`. Eight tabs:

`Overview *active* · Terminal · Packages · Services · Schedules · Events · Remote desktop · Findings (3, bad badge)`.

Active tab: `text var(--brand)`, `border-b-2 var(--brand)`. Inactive: muted text, transparent border.

### Overview body (12-col grid)

- **Security posture** `col-span-8` flush. Head: title + `Assessed 14m ago · 3 controls failing` sub + right "Score 62 / 100" (bad). Body = 2-col grid of controls; each row: 18 px round status (pass=good-soft+check, warn=warn-soft+`!`, fail=bad-soft+×) · label + optional sub · `Resolve` link if not pass.
- **Open findings · 3** `col-span-4` flush. Each: severity tag · title · `ml-1` 11 px muted detail.
- **Boot performance** `col-span-4`. 14-day bar series (60 px tall), bars `--brand` (or `--bad` when v>26 s). Footer: `−14d` / `now`.
- **Hardware warranty** `col-span-4`. List of `<Row>` (`88 px label / value`): Model · Serial (mono) · AppleCare+ (good text) · Provider link (underline).
- **CIS audit · level 1** `col-span-4`. Right tag `62%` warn. Pass/Warn/Fail counts as tone tags.
- **Auto-update** `col-span-6`. Toggle list (`30×16` pills, brand on, `#cfd6dd` off): Software updates · OS updates · Reboot window · Defer critical CVE.
- **Tags** `col-span-6`. Tag chips `#eef0f4` bg with `×` opacity .4 + `+ add tag` ghost button.

---

## Agent enroll · `/agents/new` · 920 × 720

Single 640-wide card, `padding: 20`.

1. **Choose platform** — 3 cards `macOS / Linux / Windows`. Selected = brand-soft bg + `#c8e2ec` border. Each: title 12.5 + 11 muted sub.
2. **Tag this agent** — chip stack from a curated set (`retainer`, `onsite-eligible`, `laptop`, `server`, `client:hörmann`).
3. **Run on the device** — sub `Token expires in 1 hour`. Then a `<pre>` block: `bg #0f1418`, text `#cfeaff`, `radius 6`, mono 11. Below: token meta + `Regenerate` underline.

---

## Uptime · `/uptime` · 1320 × 940

**TopBar sub:** `14 monitors · 99.94% / 30d`. Right `[New monitor]`.

### Stat row (4 cards)

`Up now 12/14 (good) · Incidents · 30d 2 (warn) · Avg response 142ms · Public status page itcake-status.app (brand link)`.

### Monitors list (flush card)

Header (10.5 uppercase): `Monitor · Type · Last 90 days · Uptime(right) · Response(right) · Status(right)`. Each row:
- `Monitor` mono 11.5 font-medium, fixed `200 px` width
- `Type` `Tag` (`HTTPS / SMTP / TCP`)
- `Last 90 days` = `UptimeStrip`: 90 cells of `5×18 px`, 1 px gap. Default `#bcd7df`, first 3 cells `#cfd6dd` (no data), incidents `--bad`
- `Uptime` right num: bad <99, warn <99.9, ink otherwise
- `Response` right num muted, `—` when down
- `Status` `<StatusPill>` good/bad

### Recent incidents card

List rows: time range (mono 11 muted, 200 px) · target (font-medium 200 px) · `Tag tone="bad">Down 26m` (120 px) · root cause muted.

---

## Audit log · `/audit` · 1320 × 1080

**TopBar sub:** `Every state-changing action across the workspace`. Right `[Export CSV]`.

### Filters card

`Range / Actor / Resource / Action` chips · right meta `184 events`.

### Event list (flush card)

Each row:
```
flex items-start gap-3 px-4 py-3 border-t hairline-2
  ┌─ when ─┐  120 px mono 10.5 muted     today · 14:38
  ┌─ actor ┐  180 px: 20 px Avatar + name (12 px, muted if 'mute' tone)
  ┌─ event ┐  flex-1:
              line 1: <Tag tone="brand">verb</Tag>  Resource (font-medium)  optional severity tag
              optional diff block (mono 11.5):
                key:  old (line-through muted) → new (ink)
  ┌─ Open ─┐  underline 11.5 muted, self-center
```

Verb tags are always `brand`-toned. Severity tags follow the same system (e.g. `crit` → bad). Diff `→` arrow is `#9aa3ad`.

Actor types in proto: `Jana K (brand)`, `Anna R (accent)`, `system (mute)`, `agent · {hostname} (mute)`.

---

## Settings · `/settings` · 1320 × 940

**TopBar:** breadcrumb `System › Settings › Workspace · General` · right `[Save changes]` primary.

### 12-col split

- **Left col `col-span-3`** (flush card): groups + items list.
  Group label `10.5 uppercase muted`. Item: `px-3 py-1.5 text-[12.5px]`. Active: `bg var(--brand-soft)`, `color var(--brand-ink)`, `font-weight 600`. Default active: first item of first group.
  Groups (in order):
  - `Workspace` — General · Branding · Numbering · Tax & VAT · Currencies · Translations
  - `Billing` — Invoices · Reminders · Payment methods · Recurring · Email templates
  - `Operations` — Agents · Auto-update defaults · Schedules · Uptime monitors · Integrations
  - `Security` — Members & roles · API tokens · SSO / SAML · Audit retention · Backups
  - `About` — Plan & usage · Status · Changelog · Support
- **Right col `col-span-9`** = vertical stack of cards (each `padding: 20`):
  - **Workspace** (`SectionHead`): 2-col `<Field>` grid → name · operator email (mono) · default language · default currency · date format · time zone (each `select` shows `▾` chevron).
  - **Numbering**: 3-col grid → Invoices `INV-{YYYY}-{seq:000}` mono + `Next: INV-2026-047` muted; same pattern for Tickets and Proposals.
  - **Tax & VAT**: table — Label · Code (mono muted) · Rate (right num font-medium) · Default for. Rows: Standard 19%, Reduced 7%, Intra-EU B2B 0%, Outside EU 0%.

In Svelte, each settings sub-route is its own `+page.svelte` under `/settings/[group]/[item]`. The left list is a `<NavList>` driven by `$page.url.pathname`.

---

## Proposals · `/proposals` · 1320 × 780

Pipeline view. `flex gap-3 overflow-auto scrollbar-thin pb-2`. Five columns × 240 px each:

| Column | Tone | Cards |
|---|---|---|
| Draft `2` | mute | 1 card |
| Sent `4` | brand | 3 cards |
| Viewed `3` | accent | 2 cards |
| Accepted `2` | good | 2 cards (each shows `Convert →` CTA in muted accent text) |
| Expired `1` | bad | 1 card (sub uses `var(--bad)`) |

Column head: `<Dot tone="brand">` · label · `· N` muted count · right `+` icon.

Card: `padding: 10`. Mono ID muted. Title 12.5 semibold. Amount num 12 brand-ink semibold. Sub muted (or bad on expired).

---

## Clients · `/clients` · 1320 × 780

Single flush card. Filters `Type=All · Country=DE · Tag=Any` · right meta `27 clients · 8 with open balance`.

Table columns: `Name · Tag · City · Open(right) · 90d revenue(right) · Avg days(right) · Last activity · ⋯`.

Row spec:
- Name: `Avatar` 22 + bold name
- Tag: `<Tag>` neutral
- Open: muted when `€0`, bad when over-due-tone client, ink otherwise
- Last activity: tone-coloured (`warn` for expired proposal, muted otherwise)

---

## Catalog · `/catalog` · 1320 × 780

12-col split, `gap-4`:

- **Categories** `col-span-3` flush. Header `Categories`. List: `All items · 34 · Hourly services · 8 · Recurring · 6 · Hardware · 12 · Software licenses · 5 · Travel & expenses · 3`. Active row brand-soft + brand-ink.
- **Items** `col-span-9` flush. Toolbar `Type / Tax / Active`. Table: `Item · Type(Tag) · Unit · Price(right num font-medium) · Tax(num muted) · Used 90d(num muted) · ⋯`.

---

## Expenses · `/expenses` · 1320 × 780

Stat row (4 cards): `This month · Reimbursable (warn if unsubmitted) · VAT recoverable · Avg / month (90d)`.

Filter row: `Period=This month · Category=All · Project=Any · Has receipt=Any` · right meta `42 expenses · €842.16 net`.

Table: `Date(mono muted) · Vendor · Category(Tag) · Project / Client (muted) · Net(right) · VAT(right muted) · Gross(right font-medium) · Receipt · ⋯`.

`Receipt` cell: `✓ PDF` (good text) or `<Tag tone="warn">missing`. Email-in flow handled via the `[Email-in]` ghost button in the topbar.

---

## Reports · `/reports` · 1320 × 1080

**TopBar sub:** `Last 12 months · EUR`. Right `[Range=L12M chip][CSV][PDF]`.

### Grid (4 cards across 12 columns)

- **Revenue by month** `col-span-8` (`padding: 16`). `<SectionHead>` with right legend (paid swatch + outstanding swatch).
  `<BarChart>`: 12 stacked bars (paid `--brand`, outstanding `--accent` at `opacity:.55`). Bar width ≈ flex-1; height 200 px in a 230 px container; month labels below.
- **Top clients · 12 months** `col-span-4` flush. List rows: name · num · `<Bar>` width = pct.
- **Tax summary · this quarter** `col-span-6` (`padding: 16`). Table rates × cols Net/VAT charged/VAT paid/Owed. Total row gets `bg #fbfcfd` and `var(--brand-ink)` Owed cell.
- **Expenses by category** `col-span-6` flush. Right-rail tag on header `▼ 4.2%` good. Each row: name · `· N%` muted · amount num + Bar.

---

## Review (in-canvas) — not a production page

The first artboard in `itcake-redesign-v2.html` (`<ReviewArtboard>`) is for visual review only. Do not port.

---

## Page-level conventions to honour everywhere

1. `Frame` always wraps. Body uses `p-5`.
2. List pages: stat row → toolbar card with filters → table → optional footer summary.
3. Detail pages: hero metrics row → tab strip → grid of cards.
4. Empty / loading / error states: see `08-states.md`.
5. The "primary action" lives only in the topbar `right` slot — never inside the body. Card-level CTAs should be `soft` or `ghost`.
6. **Never re-introduce the "Production" badge** or any decorative environment indicator.
