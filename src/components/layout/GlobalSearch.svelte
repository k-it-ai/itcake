<script lang="ts">
	import { goto } from '$app/navigation';
	import { tick } from 'svelte';
	import { fade, scale } from 'svelte/transition';
	import { t } from '$lib/i18n/index.svelte.js';

	let open = $state(false);
	let query = $state('');
	let results = $state<{ type: string; id: string; title: string; subtitle: string; href: string }[]>([]);
	let loading = $state(false);
	let selectedIndex = $state(0);
	let inputEl = $state<HTMLInputElement>();
	let dialogEl = $state<HTMLDivElement>();
	let previousFocusEl = $state<Element | null>(null);
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

	// Focus trap: constrain Tab within the dialog
	function handleDialogKeydown(e: KeyboardEvent) {
		if (e.key === 'Escape') {
			e.stopPropagation();
			open = false;
			return;
		}
		if (e.key === 'Tab' && dialogEl) {
			const focusable = dialogEl.querySelectorAll<HTMLElement>(
				'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])'
			);
			if (focusable.length === 0) return;
			const first = focusable[0];
			const last = focusable[focusable.length - 1];
			if (e.shiftKey && document.activeElement === first) {
				e.preventDefault();
				last.focus();
			} else if (!e.shiftKey && document.activeElement === last) {
				e.preventDefault();
				first.focus();
			}
		}
	}

	// Keyboard shortcut: Cmd/Ctrl+K
	function handleGlobalKeydown(e: KeyboardEvent) {
		if ((e.metaKey || e.ctrlKey) && e.key === 'k') {
			e.preventDefault();
			if (open) { open = false; } else { openSearch(); }
		}
		if (e.key === 'Escape' && open) {
			open = false;
		}
	}

	// Save/restore focus and lock body scroll when open
	$effect(() => {
		if (open) {
			previousFocusEl = document.activeElement;
			document.body.style.overflow = 'hidden';
			return () => {
				document.body.style.overflow = '';
				if (previousFocusEl instanceof HTMLElement && document.body.contains(previousFocusEl)) {
					previousFocusEl.focus();
				}
				previousFocusEl = null;
			};
		}
	});

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
		// Only allow relative paths — block javascript:, external URLs, protocol-relative, etc.
		if (!href.startsWith('/') || href.startsWith('//')) return;
		open = false;
		goto(href);
	}

	function typeIcon(type: string): string {
		if (type === 'invoice') return 'M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z';
		if (type === 'proposal') return 'M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2';
		if (type === 'expense') return 'M17 9V7a2 2 0 00-2-2H5a2 2 0 00-2 2v6a2 2 0 002 2h2m2 4h10a2 2 0 002-2v-6a2 2 0 00-2-2H9a2 2 0 00-2 2v6a2 2 0 002 2zm7-5a2 2 0 11-4 0 2 2 0 014 0z';
		return 'M17 20h5v-2a3 3 0 00-5.356-1.857M17 20H7m10 0v-2c0-.656-.126-1.283-.356-1.857M7 20H2v-2a3 3 0 015.356-1.857M7 20v-2c0-.656.126-1.283.356-1.857m0 0a5.002 5.002 0 019.288 0M15 7a3 3 0 11-6 0 3 3 0 016 0z';
	}

	$effect(() => {
		search(query);
		return () => { clearTimeout(debounceTimer); abortController?.abort(); };
	});
</script>

<svelte:window onkeydown={handleGlobalKeydown} />

<!-- Search trigger button -->
<button
	onclick={() => { open = true; tick().then(() => inputEl?.focus()); }}
	class="flex items-center gap-2 rounded-lg border border-border bg-bg px-3 py-1.5 text-sm text-near-black/60 hover:text-near-black hover:border-near-black/20 transition-colors"
	aria-label={t('action.search')}
>
	<svg class="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24" stroke-width="1.5">
		<path stroke-linecap="round" stroke-linejoin="round" d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
	</svg>
	<span class="hidden sm:inline">{t('action.search')}</span>
	<kbd class="hidden sm:inline text-xs bg-bg-card border border-border rounded px-1.5 py-0.5 font-mono">⌘K</kbd>
</button>

{#if open}
	<!-- Backdrop + dialog wrapper — onkeydown for focus trap -->
	<!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
	<div class="fixed inset-0 z-50 bg-black/30 backdrop-blur-sm" role="dialog" aria-modal="true" aria-label={t('action.search')} tabindex="-1" onkeydown={handleDialogKeydown} transition:fade={{ duration: 150 }}>
		<button class="absolute inset-0 w-full h-full cursor-default" onclick={() => open = false} aria-label={t('aria.closeSearch')}></button>
		<!-- Dialog content -->
		<div class="relative mx-auto mt-[15vh] w-full max-w-xl" bind:this={dialogEl} transition:scale={{ duration: 150, start: 0.95 }}>
			<div class="rounded-xl border border-border bg-bg-card shadow-2xl overflow-hidden">
				<!-- Search input -->
				<div class="flex items-center gap-3 border-b border-border px-4 py-3">
					<svg class="h-5 w-5 text-near-black/60 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24" stroke-width="1.5">
						<path stroke-linecap="round" stroke-linejoin="round" d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
					</svg>
					<input
						bind:this={inputEl}
						bind:value={query}
						onkeydown={handleKeydown}
						placeholder={t('search.placeholder')}
						class="flex-1 bg-transparent text-sm outline-none text-near-black placeholder:text-near-black/60"
						role="combobox"
						aria-haspopup="listbox"
						aria-expanded={open}
						aria-controls="search-results"
						aria-activedescendant={results.length > 0 ? `search-result-${selectedIndex}` : undefined}
						autocomplete="off"
					/>
					{#if loading}
						<div class="h-4 w-4 animate-spin rounded-full border-2 border-cyan border-t-transparent"></div>
					{/if}
				</div>

				<!-- Results -->
				{#if results.length > 0}
					<div class="max-h-80 overflow-y-auto py-2" role="listbox" id="search-results" aria-label={t('aria.searchResults')}>
						{#each results as result, i}
							<!-- svelte-ignore a11y_click_events_have_key_events -->
							<div
								id="search-result-{i}"
								role="option"
								tabindex="-1"
								aria-selected={i === selectedIndex}
								class="flex w-full items-center gap-3 px-4 py-2.5 text-left text-sm transition-colors cursor-pointer
									{i === selectedIndex ? 'bg-cyan/10 text-near-black' : 'text-near-black/70 hover:bg-bg/50'}"
								onclick={() => navigateTo(result.href)}
								onmouseenter={() => selectedIndex = i}
							>
								<svg class="h-4 w-4 flex-shrink-0 text-near-black/60" fill="none" stroke="currentColor" viewBox="0 0 24 24" stroke-width="1.5">
									<path stroke-linecap="round" stroke-linejoin="round" d={typeIcon(result.type)} />
								</svg>
								<div class="min-w-0 flex-1">
									<p class="font-medium truncate">{result.title}</p>
									<p class="text-xs text-near-black/60 truncate">{result.subtitle}</p>
								</div>
								<span class="text-xs uppercase text-near-black/50 flex-shrink-0">{t('entityType.' + result.type)}</span>
							</div>
						{/each}
					</div>
				{:else if query.length >= 2 && !loading}
					<div class="px-4 py-8 text-center text-sm text-near-black/60">{t('search.noResults')}</div>
				{:else}
					<div class="px-4 py-8 text-center text-sm text-near-black/60">{t('search.minChars')}</div>
				{/if}
			</div>
		</div>
	</div>
{/if}
