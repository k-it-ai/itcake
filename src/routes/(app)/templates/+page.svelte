<script lang="ts">
	import { goto, invalidateAll } from '$app/navigation';
	import TopBar from '$components/layout/TopBar.svelte';
	import Button from '$components/ui/Button.svelte';
	import Card from '$components/ui/Card.svelte';
	import Badge from '$components/ui/Badge.svelte';
	import { toast } from '$components/ui/Toast.svelte';
	import { api, getErrorMessage } from '$lib/api.js';
	import { t } from '$lib/i18n/index.svelte.js';
	import type { PageData } from './$types.js';

	let { data }: { data: PageData } = $props();
	let importing = $state(false);
	let fileInput = $state<HTMLInputElement>();

	// Track which thumbnails have loaded / failed
	let thumbnailStatus = $state<Record<string, 'loading' | 'loaded' | 'error'>>({});

	function handleThumbnailLoad(id: string) {
		thumbnailStatus[id] = 'loaded';
	}
	function handleThumbnailError(id: string) {
		thumbnailStatus[id] = 'error';
	}

	async function handleImport() {
		const file = fileInput?.files?.[0];
		if (!file) return;
		if (file.size > 1_000_000) { toast(t('template.fileTooLarge'), 'error'); return; }
		importing = true;
		try {
			const text = await file.text();
			let data: Record<string, unknown>;
			try { data = JSON.parse(text); } catch { toast(t('template.invalidJson'), 'error'); importing = false; return; }
			if (typeof data.html === 'string' && data.html.length > 500_000) { toast(t('template.htmlTooLarge'), 'error'); importing = false; return; }
			if (typeof data.css === 'string' && data.css.length > 500_000) { toast(t('template.cssTooLarge'), 'error'); importing = false; return; }
			await api.post('/api/templates', {
				name: typeof data.name === 'string' ? data.name.slice(0, 200) : 'Imported Template',
				html: typeof data.html === 'string' ? data.html : '',
				css: typeof data.css === 'string' ? data.css : '',
				options: Array.isArray(data.options) ? data.options : []
			});
			toast(t('toast.saved'));
			await invalidateAll();
		} catch (e) {
			toast(getErrorMessage(e, t('toast.error')), 'error');
		}
		importing = false;
		if (fileInput) fileInput.value = '';
	}
</script>

<TopBar title={t('template.titlePlural')}>
	{#snippet children()}
		<input bind:this={fileInput} type="file" accept=".json" class="hidden" onchange={handleImport} />
		<Button variant="secondary" size="sm" loading={importing} onclick={() => fileInput?.click()}>{t('action.import')}</Button>
	{/snippet}
</TopBar>

<div class="p-6">
	<div class="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
		{#each data.templates as template}
			<button type="button" class="rounded-lg border border-border bg-bg-card p-4 cursor-pointer hover:border-cyan transition-colors text-left" onclick={() => goto(`/templates/${template.id}`)}>
				<div class="aspect-[210/297] bg-bg rounded border border-border mb-3 flex items-center justify-center text-near-black/20 overflow-hidden relative">
					{#if thumbnailStatus[template.id] !== 'error'}
						<img
							src="/api/templates/{template.id}/thumbnail"
							alt={t('aria.templatePreview', { name: template.name })}
							class="absolute inset-0 w-full h-full object-cover object-top"
							loading="lazy"
							onload={() => handleThumbnailLoad(template.id)}
							onerror={() => handleThumbnailError(template.id)}
						/>
					{/if}
					{#if thumbnailStatus[template.id] !== 'loaded'}
						<svg class="h-12 w-12" fill="none" stroke="currentColor" viewBox="0 0 24 24">
							<path stroke-linecap="round" stroke-linejoin="round" stroke-width="1.5" d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
						</svg>
					{/if}
				</div>
				<div class="flex items-center justify-between">
					<h3 class="font-medium text-near-black">{template.name}</h3>
					{#if template.builtIn}
						<Badge>{t('template.builtIn')}</Badge>
					{/if}
				</div>
			</button>
		{/each}
	</div>
</div>
