<script lang="ts">
	import TopBar from '#lib/components/shell/TopBar.svelte';
	import Card from '#lib/components/ui/Card.svelte';
	import Tag from '#lib/components/ui/Tag.svelte';
	import Btn from '#lib/components/ui/Btn.svelte';
	import SectionHead from '#lib/components/ui/SectionHead.svelte';
	import { Download } from '#lib/icons/index.js';
	import { t } from '#lib/i18n/index.svelte.js';
	import type { PageData } from './$types.js';

	let { data }: { data: PageData } = $props();
	let tmpl = $derived(data.template);
</script>

<TopBar
	title={t('page.template', { name: tmpl.name })}
	breadcrumb={['System', t('settings.title'), t('template.title'), tmpl.name]}
>
	{#snippet right()}
		{#if tmpl.builtIn}
			<Tag tone="neutral">{t('badge.builtInReadOnly')}</Tag>
		{/if}
		<Btn variant="ghost" size="sm" href="/settings#template">
			{t('action.back')}
		</Btn>
		<Btn variant="primary" size="sm" href="/api/templates/{tmpl.id}/export">
			{#snippet icon()}<Download size={14} strokeWidth={1.6} />{/snippet}
			{t('action.export')}
		</Btn>
	{/snippet}
</TopBar>

<div class="p-5 space-y-4">
	<p class="text-[12px]" style="color:var(--muted)">{t('help.templateEjsSyntax')}</p>

	<Card padding={16}>
		<SectionHead title={t('section.templateHtml')} />
		<pre
			class="rounded-md p-3 overflow-x-auto text-[11.5px] font-mono max-h-96 overflow-y-auto"
			style="background:#fbfcfd; border:1px solid var(--line-2); color:var(--ink)"
		>{tmpl.html}</pre>
	</Card>

	{#if tmpl.css}
		<Card padding={16}>
			<SectionHead title={t('section.templateCss')} />
			<pre
				class="rounded-md p-3 overflow-x-auto text-[11.5px] font-mono max-h-96 overflow-y-auto"
				style="background:#fbfcfd; border:1px solid var(--line-2); color:var(--ink)"
			>{tmpl.css}</pre>
		</Card>
	{/if}

	{#if tmpl.options.length > 0}
		<Card padding={16}>
			<SectionHead title={t('section.options')} />
			<div class="space-y-2">
				{#each tmpl.options as opt (opt.key)}
					<div class="flex items-center gap-3 text-[12.5px] py-1.5 border-b last:border-b-0" style="border-color:var(--line-2)">
						<span class="font-medium" style="color:var(--ink)">{opt.label}</span>
						<span class="font-mono text-[11.5px]" style="color:var(--muted)">{opt.key}</span>
						<Tag tone="neutral">{opt.type}</Tag>
						<span class="ml-auto text-[11.5px]" style="color:var(--muted)">
							{t('badge.default')}: <span class="font-mono">{String(opt.default)}</span>
						</span>
					</div>
				{/each}
			</div>
		</Card>
	{/if}
</div>
