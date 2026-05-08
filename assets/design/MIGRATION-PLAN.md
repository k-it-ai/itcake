# v2 design — migration plan

The token foundation, primitives, and shell components have shipped. The live shell (`src/routes/(app)/+layout.svelte` + `src/components/layout/{Sidebar,TopBar,GlobalSearch,QuickCreate}.svelte`) is **unchanged** so existing routes keep working. This plan tracks how to swap them in safely.

## Phase 1 — Per-route title/breadcrumb (must land before shell swap)

The v2 `TopBar` needs `title`, `sub` (optional), `breadcrumb` (optional `[{label, href?}]`) from each page. Today the v1 `TopBar` is rendered inside each page's component, so the data lives in markup rather than as named exports.

Two compatible patterns:

**A · `+page.ts` `meta` export** (recommended)

```ts
// src/routes/(app)/invoices/+page.ts
export const meta = {
  title: 'Invoices',
  breadcrumb: [{ label: 'Billing' }, { label: 'Invoices' }]
};
```

`(app)/+layout.ts` reads `data.meta` and exposes it through `data`. The shell component reads `page.data.meta` reactively.

**B · `setContext('pageMeta', ...)` from `+page.svelte`**

Per-page svelte file calls `setContext('pageMeta', { title, sub, breadcrumb })` at top-of-script. The shell reads it via `getContext`. Loses SSR-time titles in the document `<title>` tag unless we also surface it via `data`.

Pick (A). Fewer moving parts, works under SSR.

Migrate one page at a time, lowest-traffic first (Settings, Audit) so a regression is caught before the dashboard breaks.

## Phase 2 — Wire `Frame` into `(app)/+layout.svelte`

Replace the body of `(app)/+layout.svelte` with:

```svelte
<script lang="ts">
  import Frame from '$lib/components/shell/Frame.svelte';
  import ChatPanel from '$components/ai/ChatPanel.svelte';
  // … keep AI/chat wiring, drop sidebar collapse logic + skip link (moved into Frame)
</script>

<Frame
  title={page.data.meta?.title ?? ''}
  sub={page.data.meta?.sub}
  breadcrumb={page.data.meta?.breadcrumb}
  userName={page.data.user?.name}
  userEmail={page.data.user?.email}
>
  {@render children()}
</Frame>

{#if aiEnabled}
  <!-- AI chat FAB stays — the v2 spec doesn't replace it -->
  <button …></button>
  <ChatPanel … />
{/if}
```

Constraints:
- `Frame` already mounts `CommandPalette` and binds the `⌘K` hotkey, so the `(app)` layout no longer needs `setContext('toggleSidebar', …)`.
- The mobile collapse logic in `(app)/+layout.svelte` is dropped; the v2 `Sidebar` is fixed-228 px in v2 (v3 will introduce collapse via a feature flag).
- The skip-to-content link is rebuilt inside `Frame`.

## Phase 3 — Per-page primitive adoption

Order from `00-README.md`:

1. Dashboard, Invoices, Tickets — highest traffic
2. Agents detail → Agents list → Agents enroll
3. Proposals, Clients, Catalog, Expenses, Reports — parallelisable
4. Uptime, Audit log, Settings — least interactive logic

For each page, replace ad-hoc markup with the v2 primitives (`Tag`, `Btn`, `StatusPill`, `Card`, etc.) per `05-pages.md`. Status colours through the new `tone` prop (`good`/`warn`/`bad`/`accent`/`brand`/`neutral`/`ink`) per `06-status-system.md`.

## Phase 4 — Decommission v1 shell

Once every route under `(app)` has switched to `Frame`, delete:

- `src/components/layout/Sidebar.svelte`
- `src/components/layout/TopBar.svelte`
- `src/components/layout/GlobalSearch.svelte`
- `src/components/layout/QuickCreate.svelte`

Drop `theme` toggle if it isn't reintroduced (the v2 spec is light-only; dark theme is post-v2 work).

## Test gates per phase

- Phase 1 ends when `tests/integration/lifecycle.test.ts` page-load assertions still pass (each page renders + asserts known text). Add `expect(title).toBe('Invoices')` etc. as titles get migrated.
- Phase 2 ends when `npm run check` is clean and a manual smoke (login → dashboard → invoices → tickets → settings) shows the v2 chrome.
- Phase 3 ends per-page: a small unit test asserting one v2 primitive is rendered on the page (`querySelectorAll('[data-tone]')` returns ≥ 1, etc.).
- Phase 4 is just `git rm` + a green `npm run check`.

## Out of scope (yet)

- `lib/components/ops/`, `lib/components/billing/`, `lib/components/audit/`, `lib/components/settings/` page-specific atoms from `10-svelte-map.md`. Build them as the corresponding pages migrate; trying to scaffold all 20+ at once produces a pile of unused components that the migration then has to chase.
- `viz/` charts. The current PostureCard / boot-perf / uptime visuals are inline; replace lazily.
- Theme toggle. Off the v2 critical path.

## Token / migration helper

For pages still on v1 tokens, the legacy `--app-*` CSS vars in `src/app.css` alias to the v2 vars, so an unmigrated page keeps rendering correctly. Migrating a page means switching its class names from `bg-bg-card` to `bg-card`, `text-near-black` to `text-ink`, etc.
