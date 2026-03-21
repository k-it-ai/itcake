<script lang="ts">
	import TopBar from '$components/layout/TopBar.svelte';
	import Card from '$components/ui/Card.svelte';
	import Badge from '$components/ui/Badge.svelte';
	import { t } from '$lib/i18n/index.svelte.js';
	import type { PageData } from './$types.js';

	let { data }: { data: PageData } = $props();
	let tmpl = $derived(data.template);
</script>

<TopBar title={t('page.template', { name: tmpl.name })} backHref="/settings#templates">
	{#snippet children()}
		{#if tmpl.builtIn}
			<Badge>{t('badge.builtInReadOnly')}</Badge>
		{/if}
		<a href="/api/templates/{tmpl.id}/export" download class="inline-flex items-center gap-1 rounded-lg border border-border bg-bg-card px-3 py-1.5 text-sm font-medium text-near-black hover:bg-bg transition-colors">{t('action.export')}</a>
		<a href="/settings#templates" class="text-sm text-near-black/60 hover:text-near-black">{t('action.back')}</a>
	{/snippet}
</TopBar>

<div class="p-6 space-y-6">
	<p class="text-sm text-near-black/60">{t('help.templateEjsSyntax')}</p>
	<Card>
		<h2 class="text-lg font-semibold mb-4">{t('section.templateHtml')}</h2>
		<pre class="bg-bg rounded-lg p-4 overflow-x-auto text-sm font-mono text-near-black max-h-96 overflow-y-auto">{tmpl.html}</pre>
	</Card>

	{#if tmpl.css}
		<Card>
			<h2 class="text-lg font-semibold mb-4">{t('section.templateCss')}</h2>
			<pre class="bg-bg rounded-lg p-4 overflow-x-auto text-sm font-mono text-near-black max-h-96 overflow-y-auto">{tmpl.css}</pre>
		</Card>
	{/if}

	{#if tmpl.options.length > 0}
		<Card>
			<h2 class="text-lg font-semibold mb-4">{t('section.options')}</h2>
			<div class="space-y-2">
				{#each tmpl.options as opt}
					<div class="flex items-center gap-4 text-sm">
						<span class="font-medium">{opt.label}</span>
						<span class="text-near-black/60">{opt.key} ({opt.type})</span>
						<span class="text-near-black/60">{t('badge.default')}: {String(opt.default)}</span>
					</div>
				{/each}
			</div>
		</Card>
	{/if}
</div>
