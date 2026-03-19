<script lang="ts">
	import { goto } from '$app/navigation';
	import { tick } from 'svelte';
	import { t } from '$lib/i18n/index.svelte.js';

	let open = $state(false);
	let query = $state('');
	let results = $state<{ type: string; id: string; title: string; subtitle: string; href: string }[]>([]);
	let loading = $state(false);
	let selectedIndex = $state(0);
	let inputEl = $state<HTMLInputElement>();
	let wrapperEl = $state<HTMLDivElement>();
	let debounceTimer: ReturnType<typeof setTimeout>;
	let abortController: AbortController | null = null;

	// Exported function to open search programmatically (used by TopBar mobile button)
	export function openSearch() {
		open = true;
		query = '';
		results = [];
		selectedIndex = 0;
		tick().then(() => inputEl?.focus());
	}

	function closeSearch() {
		open = false;
		query = '';
		results = [];
	}

	// Keyboard shortcut: Cmd/Ctrl+K
	function handleGlobalKeydown(e: KeyboardEvent) {
		if ((e.metaKey || e.ctrlKey) && e.key === 'k') {
			e.preventDefault();
			if (open) { closeSearch(); } else { openSearch(); }
		}
		if (e.key === 'Escape' && open) {
			closeSearch();
		}
	}

	function search(q: string) {
		clearTimeout(debounceTimer);
		abortController?.abort();
		if (q.trim().length < 2) {
			results = [];
			loading = false;
			return;
		}
		loading = true;
		debounceTimer = setTimeout(async () => {
			abortController?.abort();
			const controller = new AbortController();
			abortController = controller;
			try {
				const res = await fetch(`/api/search?q=${encodeURIComponent(q)}`, { signal: controller.signal });
				if (res.ok && !controller.signal.aborted) {
					results = await res.json();
					selectedIndex = 0;
				}
			} catch (e) {
				if (e instanceof DOMException && e.name === 'AbortError') return;
				console.warn('Search failed:', e);
			}
			if (!controller.signal.aborted) loading = false;
		}, 200);
	}

	function handleKeydown(e: KeyboardEvent) {
		if (e.key === 'Escape') {
			e.preventDefault();
			closeSearch();
			return;
		}
		if (e.key === 'ArrowDown') {
			e.preventDefault();
			selectedIndex = Math.min(selectedIndex + 1, results.length - 1);
		} else if (e.key === 'ArrowUp') {
			e.preventDefault();
			selectedIndex = Math.max(selectedIndex - 1, 0);
		} else if (e.key === 'Enter' && results[selectedIndex]) {
			e.preventDefault();
			navigateTo(results[selectedIndex].href);
		}
	}

	function navigateTo(href: string) {
		if (!href.startsWith('/') || href.startsWith('//')) return;
		closeSearch();
		goto(href);
	}

	function typeIcon(type: string): string {
		if (type === 'invoice') return 'M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z';
		if (type === 'proposal') return 'M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2';
		if (type === 'expense') return 'M17 9V7a2 2 0 00-2-2H5a2 2 0 00-2 2v6a2 2 0 002 2h2m2 4h10a2 2 0 002-2v-6a2 2 0 00-2-2H9a2 2 0 00-2 2v6a2 2 0 002 2zm7-5a2 2 0 11-4 0 2 2 0 014 0z';
		if (type === 'ticket') return 'M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z';
		if (type === 'monitor') return 'M3.055 11H5a2 2 0 012 2v1a2 2 0 002 2 2 2 0 012 2v2.945M8 3.935V5.5A2.5 2.5 0 0010.5 8h.5a2 2 0 012 2 2 2 0 104 0 2 2 0 012-2h1.064M15 20.488V18a2 2 0 012-2h3.064M21 12a9 9 0 11-18 0 9 9 0 0118 0z';
		if (type === 'catalog_item') return 'M19 11H5m14 0a2 2 0 012 2v6a2 2 0 01-2 2H5a2 2 0 01-2-2v-6a2 2 0 012-2m14 0V9a2 2 0 00-2-2M5 11V9a2 2 0 012-2m0 0V5a2 2 0 012-2h6a2 2 0 012 2v2M7 7h10';
		return 'M17 20h5v-2a3 3 0 00-5.356-1.857M17 20H7m10 0v-2c0-.656-.126-1.283-.356-1.857M7 20H2v-2a3 3 0 015.356-1.857M7 20v-2c0-.656.126-1.283.356-1.857m0 0a5.002 5.002 0 019.288 0M15 7a3 3 0 11-6 0 3 3 0 016 0z';
	}

	$effect(() => {
		search(query);
		return () => { clearTimeout(debounceTimer); abortController?.abort(); };
	});
</script>

<svelte:window onkeydown={handleGlobalKeydown} />

<div class="relative {open ? 'w-full max-w-md' : 'w-auto max-w-[220px] sm:max-w-xs'} transition-all duration-200" bind:this={wrapperEl}>
	{#if !open}
		<!-- Compact trigger -->
		<button
			onclick={openSearch}
			class="flex items-center gap-2 rounded-lg border border-border bg-bg px-3 py-1.5 text-sm text-near-black/60 hover:text-near-black hover:border-near-black/20 transition-colors w-full"
			aria-label={t('action.search')}
		>
			<svg class="h-4 w-4 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24" stroke-width="1.5">
				<path stroke-linecap="round" stroke-linejoin="round" d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
			</svg>
			<span class="hidden sm:inline truncate">{t('action.search')}</span>
			<kbd class="hidden md:inline text-xs bg-bg-card border border-border rounded px-1.5 py-0.5 font-mono ml-auto">⌘K</kbd>
		</button>
	{:else}
		<!-- Expanded inline search -->
		<div class="flex items-center gap-2 rounded-lg border border-cyan bg-bg-card px-3 py-1.5 text-sm ring-1 ring-cyan/30 w-full">
			<svg class="h-4 w-4 text-cyan flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24" stroke-width="1.5">
				<path stroke-linecap="round" stroke-linejoin="round" d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
			</svg>
			<input
				bind:this={inputEl}
				bind:value={query}
				onkeydown={handleKeydown}
				onblur={() => { setTimeout(() => { if (!wrapperEl?.contains(document.activeElement)) closeSearch(); }, 150); }}
				placeholder={t('search.placeholder')}
				class="flex-1 bg-transparent outline-none text-near-black placeholder:text-near-black/40 min-w-0"
				role="combobox"
				aria-haspopup="listbox"
				aria-expanded={results.length > 0}
				aria-controls="inline-search-results"
				aria-activedescendant={results.length > 0 ? `inline-search-result-${selectedIndex}` : undefined}
				autocomplete="off"
			/>
			{#if loading}
				<div class="h-4 w-4 animate-spin rounded-full border-2 border-cyan border-t-transparent flex-shrink-0"></div>
			{/if}
			<button onclick={closeSearch} class="text-near-black/40 hover:text-near-black flex-shrink-0" aria-label={t('action.cancel')}>
				<svg class="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24" stroke-width="1.5">
					<path stroke-linecap="round" stroke-linejoin="round" d="M6 18L18 6M6 6l12 12" />
				</svg>
			</button>
		</div>

		<!-- Results dropdown -->
		{#if query.length >= 2}
			<!-- svelte-ignore a11y_no_static_element_interactions -->
			<div class="absolute left-0 right-0 top-full mt-1 z-50 rounded-lg border border-border bg-bg-card shadow-lg overflow-hidden">
				{#if results.length > 0}
					<div class="max-h-80 overflow-y-auto py-1" role="listbox" id="inline-search-results" aria-label={t('aria.searchResults')}>
						{#each results as result, i}
							<!-- svelte-ignore a11y_click_events_have_key_events -->
							<div
								id="inline-search-result-{i}"
								role="option"
								tabindex="-1"
								aria-selected={i === selectedIndex}
								class="flex w-full items-center gap-3 px-3 py-2 text-left text-sm transition-colors cursor-pointer
									{i === selectedIndex ? 'bg-cyan/10 text-near-black' : 'text-near-black/70 hover:bg-bg/50'}"
								onclick={() => navigateTo(result.href)}
								onmouseenter={() => selectedIndex = i}
							>
								<svg class="h-4 w-4 flex-shrink-0 text-near-black/50" fill="none" stroke="currentColor" viewBox="0 0 24 24" stroke-width="1.5">
									<path stroke-linecap="round" stroke-linejoin="round" d={typeIcon(result.type)} />
								</svg>
								<div class="min-w-0 flex-1">
									<p class="font-medium truncate">{result.title}</p>
									<p class="text-xs text-near-black/50 truncate">{result.subtitle}</p>
								</div>
								<span class="text-xs uppercase text-near-black/40 flex-shrink-0">{t('entityType.' + result.type)}</span>
							</div>
						{/each}
					</div>
				{:else if !loading}
					<div class="px-3 py-4 text-center text-sm text-near-black/50">{t('search.noResults')}</div>
				{/if}
			</div>
		{/if}
	{/if}
</div>
