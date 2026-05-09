<script lang="ts">
	import { tick } from 'svelte';
	import { goto } from '$app/navigation';
	import { palette, type PaletteScope, type PaletteResult } from '$lib/stores/palette.svelte.js';
	import { t } from '$lib/i18n/index.svelte.js';
	import { Search, Command, ArrowRight } from '$lib/icons';

	const SCOPES: { id: PaletteScope; tKey: string }[] = [
		{ id: 'all', tKey: 'palette.scope.all' },
		{ id: 'invoices', tKey: 'palette.scope.invoices' },
		{ id: 'tickets', tKey: 'palette.scope.tickets' },
		{ id: 'clients', tKey: 'palette.scope.clients' },
		{ id: 'agents', tKey: 'palette.scope.agents' },
		{ id: 'commands', tKey: 'palette.scope.commands' }
	];

	let inputEl = $state<HTMLInputElement | undefined>(undefined);
	let listEl = $state<HTMLDivElement | undefined>(undefined);

	$effect(() => {
		if (palette.open) {
			tick().then(() => inputEl?.focus());
		}
	});

	$effect(() => {
		const q = palette.query;
		const s = palette.scope;
		// Re-run providers any time query or scope changes; debounced inside
		// providers if they hit the network.
		void q;
		void s;
		void palette.runProviders();
	});

	$effect(() => {
		const idx = palette.highlightIndex;
		if (!listEl) return;
		const el = listEl.querySelector<HTMLElement>(`[data-result-idx="${idx}"]`);
		el?.scrollIntoView({ block: 'nearest' });
	});

	function handleKey(e: KeyboardEvent) {
		if (e.key === 'Escape') {
			e.preventDefault();
			palette.resetQuery();
			palette.close();
		} else if (e.key === 'ArrowDown') {
			e.preventDefault();
			palette.moveDown();
		} else if (e.key === 'ArrowUp') {
			e.preventDefault();
			palette.moveUp();
		} else if (e.key === 'Enter') {
			e.preventDefault();
			activate(palette.highlightIndex);
		}
	}

	function activate(idx: number) {
		const result = palette.results[idx];
		if (!result) return;
		palette.close();
		if (result.action) {
			void result.action();
		} else if (result.href) {
			void goto(result.href);
		}
	}

	function highlightSubstring(label: string, q: string): { text: string; match: boolean }[] {
		if (!q) return [{ text: label, match: false }];
		const lower = label.toLowerCase();
		const needle = q.toLowerCase();
		const i = lower.indexOf(needle);
		if (i < 0) return [{ text: label, match: false }];
		return [
			{ text: label.slice(0, i), match: false },
			{ text: label.slice(i, i + q.length), match: true },
			{ text: label.slice(i + q.length), match: false }
		];
	}

	const grouped = $derived.by(() => {
		const map = new Map<string, { groupTKey?: string; results: { result: PaletteResult; index: number }[] }>();
		palette.results.forEach((result, index) => {
			const key = result.group;
			let entry = map.get(key);
			if (!entry) {
				entry = { groupTKey: result.groupTKey, results: [] };
				map.set(key, entry);
			}
			entry.results.push({ result, index });
		});
		return [...map.entries()].map(([group, value]) => ({ group, ...value }));
	});
</script>

{#if palette.open}
	<button
		type="button"
		class="fixed inset-0 z-40 cursor-default border-0 p-0"
		style="background: linear-gradient(180deg, rgba(12,17,22,.55) 0%, rgba(27,38,45,.55) 100%);"
		aria-label={t('action.close')}
		onclick={() => palette.close()}
	></button>

	<div
		role="dialog"
		aria-modal="true"
		aria-label={t('palette.dialog')}
		class="fixed left-1/2 top-[15vh] z-50 w-[640px] max-w-[calc(100vw-48px)] -translate-x-1/2 rounded-lg border shadow-pop"
		style="background: var(--card); border-color: var(--line);"
	>
		<!-- Search input -->
		<div class="flex items-center gap-2.5 border-b px-4 py-3" style="border-color: var(--line);">
			<Search size={16} strokeWidth={1.6} aria-hidden="true" style="color: var(--muted);" />
			<input
				bind:this={inputEl}
				type="text"
				value={palette.query}
				oninput={(e) => (palette.query = (e.currentTarget as HTMLInputElement).value)}
				onkeydown={handleKey}
				placeholder={t('palette.placeholder')}
				class="flex-1 border-none bg-transparent text-[14px] outline-none placeholder:opacity-60"
				style="color: var(--ink);"
				aria-controls="palette-results"
				aria-autocomplete="list"
			/>
			<kbd
				class="rounded border px-1.5 py-px font-mono text-[10.5px]"
				style="border-color: var(--line); color: var(--muted);"
			>esc</kbd>
		</div>

		<!-- Scopes + hint -->
		<div class="flex items-center justify-between gap-3 border-b px-4 py-2" style="border-color: var(--line); background: #fbfcfd;">
			<div class="flex flex-wrap items-center gap-1.5">
				<span class="mr-1 text-[11px]" style="color: var(--muted);">{t('palette.scopeLabel')}</span>
				{#each SCOPES as s (s.id)}
					{@const active = palette.scope === s.id}
					<button
						type="button"
						aria-pressed={active}
						class="rounded-md border px-2 py-0.5 text-[11.5px] transition-colors focus-visible:outline-none focus-visible:ring-2"
						style="background: {active ? 'var(--brand-soft)' : 'transparent'}; color: {active ? 'var(--brand-ink)' : 'var(--muted)'}; border-color: {active ? '#c8e2ec' : 'transparent'}; --tw-ring-color: var(--brand);"
						onclick={() => (palette.scope = s.id)}
					>
						{t(s.tKey)}
					</button>
				{/each}
			</div>
			<div class="hidden items-center gap-1 font-mono text-[10.5px] sm:flex" style="color: var(--muted);">
				<kbd class="rounded border px-1 py-px" style="border-color: var(--line);">↑↓</kbd>
				<kbd class="rounded border px-1 py-px" style="border-color: var(--line);">↵</kbd>
				<kbd class="rounded border px-1 py-px" style="border-color: var(--line);">⌘↵</kbd>
			</div>
		</div>

		<!-- Results -->
		<div
			bind:this={listEl}
			id="palette-results"
			role="listbox"
			class="max-h-[480px] overflow-auto py-1"
			tabindex="-1"
			aria-label={t('palette.results')}
		>
			{#if palette.loading && palette.results.length === 0}
				<div class="px-3.5 py-6 text-center text-[12px]" style="color: var(--muted);">
					{t('palette.loading')}
				</div>
			{:else if palette.results.length === 0}
				<div class="px-3.5 py-6 text-center text-[12px]" style="color: var(--muted);">
					{palette.query ? t('palette.noResults') : t('palette.startTyping')}
				</div>
			{:else}
				{#each grouped as bucket (bucket.group)}
					<div class="px-3.5 pt-2 pb-1 text-[10.5px] font-medium uppercase tracking-wider" style="color: var(--muted);">
						{bucket.groupTKey ? t(bucket.groupTKey) : bucket.group}
					</div>
					{#each bucket.results as { result, index } (result.id)}
						{@const isHighlight = palette.highlightIndex === index}
						{@const Icon = result.icon}
						<button
							type="button"
							role="option"
							aria-selected={isHighlight}
							data-result-idx={index}
							class="flex w-full items-center gap-2.5 px-3.5 py-2 text-left text-[12.5px] transition-colors focus-visible:outline-none"
							style="background: {isHighlight ? 'var(--brand-soft)' : 'transparent'}; color: var(--ink);"
							onmouseenter={() => (palette.highlightIndex = index)}
							onclick={() => activate(index)}
						>
							{#if Icon}
								<Icon size={14} strokeWidth={1.6} aria-hidden="true" style="color: var(--muted); flex-shrink: 0;" />
							{:else}
								<ArrowRight size={14} strokeWidth={1.6} aria-hidden="true" style="color: var(--muted); flex-shrink: 0;" />
							{/if}
							<span class="min-w-0 flex-1 truncate">
								{#each highlightSubstring(result.label, palette.query) as part, i (i)}
									{#if part.match}
										<b class="font-semibold">{part.text}</b>
									{:else}{part.text}{/if}
								{/each}
							</span>
							{#if result.meta}
								<span class="ml-2 shrink-0 truncate font-mono text-[11px]" style="color: var(--muted);">{result.meta}</span>
							{/if}
						</button>
					{/each}
				{/each}
			{/if}
		</div>

		<!-- Footer -->
		<div class="flex items-center justify-between gap-3 border-t px-4 py-2 text-[11px]" style="border-color: var(--line); color: var(--muted);">
			<span class="tabular-nums">
				{#if palette.results.length === 1}
					{t('palette.resultCount.one')}
				{:else}
					{t('palette.resultCount.other', { count: palette.results.length })}
				{/if}
			</span>
			<span class="hidden items-center gap-1.5 sm:flex">
				<Command size={12} strokeWidth={1.6} aria-hidden="true" />
				<span>{t('palette.footerHint')}</span>
			</span>
		</div>
	</div>
{/if}
