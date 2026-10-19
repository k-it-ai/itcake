<script lang="ts">
	import type { Snippet } from 'svelte';
	import { t } from '#lib/i18n/index.svelte.js';
	import { palette } from '#lib/stores/palette.svelte.js';
	import { Search } from '#lib/icons/index.js';
	import Kbd from '#lib/components/ui/Kbd.svelte';

	interface Props {
		title: string;
		breadcrumb?: string[];
		sub?: string;
		right?: Snippet;
	}

	const { title, breadcrumb = [], sub, right }: Props = $props();
</script>

<header
	class="flex shrink-0 items-end justify-between gap-4 border-b px-5 py-3"
	style="min-height: 54px; background: var(--card); border-color: var(--line);"
>
	<div class="min-w-0 flex-1">
		{#if breadcrumb.length > 0}
			<nav aria-label="Breadcrumb" class="mb-0.5 flex items-center gap-1 text-[11px]" style="color: var(--muted);">
				{#each breadcrumb as crumb, i (i)}
					{#if i > 0}
						<span aria-hidden="true" class="opacity-50">›</span>
					{/if}
					<span class={i === breadcrumb.length - 1 ? 'text-ink' : ''} style={i === breadcrumb.length - 1 ? 'color: var(--ink);' : ''}>
						{crumb}
					</span>
				{/each}
			</nav>
		{/if}
		<div class="flex items-baseline gap-2">
			<h1 class="truncate text-[18px] font-semibold leading-tight" style="color: var(--ink);">{title}</h1>
			{#if sub}
				<span class="truncate text-[12px]" style="color: var(--muted);">{sub}</span>
			{/if}
		</div>
	</div>

	<button
		type="button"
		onclick={() => palette.openPalette()}
		class="hidden items-center gap-2 rounded-md border px-2.5 py-1.5 text-[12px] transition-colors md:flex focus-visible:outline-none focus-visible:ring-2"
		style="background: #fbfcfd; border-color: var(--line); color: var(--muted); min-width: 240px; --tw-ring-color: var(--brand);"
		aria-label={t('palette.openLabel')}
	>
		<Search size={14} strokeWidth={1.6} aria-hidden="true" />
		<span class="flex-1 truncate text-left">{t('palette.placeholder')}</span>
		<Kbd keys="⌘K" />
	</button>

	{#if right}
		<div class="flex shrink-0 items-center gap-2">
			{@render right()}
		</div>
	{/if}
</header>
