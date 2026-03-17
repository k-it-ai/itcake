<script lang="ts">
	import { page } from '$app/state';
	import Button from '$components/ui/Button.svelte';
	import { t } from '$lib/i18n/index.svelte.js';

	const invoiceId = $derived(page.params.id);
</script>

<div class="flex flex-col h-screen bg-neutral-200 dark:bg-neutral-800">
	<div class="flex items-center justify-between px-4 py-2 bg-neutral-100 dark:bg-neutral-900 border-b border-neutral-300 dark:border-neutral-700">
		<a href="/invoices/{invoiceId}" class="inline-flex items-center gap-1.5 text-sm text-cyan hover:text-cyan-dark">
			<svg class="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24" stroke-width="2">
				<path stroke-linecap="round" stroke-linejoin="round" d="M10.5 19.5L3 12m0 0l7.5-7.5M3 12h18" />
			</svg>
			{t('invoice.backToInvoice')}
		</a>
		<div class="flex gap-2">
			<a href="/api/invoices/{invoiceId}/pdf" target="_blank">
				<Button size="sm" variant="secondary">{t('action.downloadPdf')}</Button>
			</a>
		</div>
	</div>
	<div class="flex-1 overflow-auto flex justify-center py-6 px-4">
		<iframe
			src="/api/invoices/{invoiceId}/preview"
			class="w-full border-0 bg-white shadow-lg rounded"
			style="max-width: 210mm; aspect-ratio: 210/297;"
			title={t('invoice.previewTitle')}
			sandbox="allow-same-origin"
		></iframe>
	</div>
</div>
