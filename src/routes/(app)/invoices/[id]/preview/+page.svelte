<script lang="ts">
	import { page } from '$app/state';
	import TopBar from '#lib/components/shell/TopBar.svelte';
	import Btn from '#lib/components/ui/Btn.svelte';
	import { t } from '#lib/i18n/index.svelte.js';

	const invoiceId = $derived(page.params.id ?? '');
</script>

<TopBar
	title={t('invoice.previewTitle')}
	breadcrumb={['Billing', t('invoice.titlePlural'), invoiceId, t('misc.previewLabel')]}
>
	{#snippet right()}
		<Btn variant="ghost" size="sm" href="/invoices/{invoiceId}">{t('invoice.backToInvoice')}</Btn>
		<Btn variant="primary" size="sm" href="/api/invoices/{invoiceId}/pdf" target="_blank" rel="noopener noreferrer">{t('action.downloadPdf')}</Btn>
	{/snippet}
</TopBar>

<div class="p-5 flex justify-center">
	<iframe
		src="/api/invoices/{invoiceId}/preview"
		class="w-full border-0 bg-[var(--card)] shadow-pop rounded-md"
		style="max-width: 210mm; aspect-ratio: 210/297;"
		title={t('invoice.previewTitle')}
		sandbox="allow-same-origin"
	></iframe>
</div>
