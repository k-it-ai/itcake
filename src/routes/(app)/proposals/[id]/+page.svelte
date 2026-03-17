<script lang="ts">
	import { untrack } from 'svelte';
	import { enhance } from '$app/forms';
	import TopBar from '$components/layout/TopBar.svelte';
	import Button from '$components/ui/Button.svelte';
	import Card from '$components/ui/Card.svelte';
	import Input from '$components/ui/Input.svelte';
	import Select from '$components/ui/Select.svelte';
	import RichTextArea from '$components/ui/RichTextArea.svelte';
	import Badge from '$components/ui/Badge.svelte';
	import LineItemEditor from '$components/forms/LineItemEditor.svelte';
	import DiscountEditor from '$components/forms/DiscountEditor.svelte';
	import TemplateOptionsEditor from '$components/forms/TemplateOptionsEditor.svelte';
	import InvoiceSummary from '$components/invoice/InvoiceSummary.svelte';
	import ConfirmDialog from '$components/ui/ConfirmDialog.svelte';
	import EmailPreviewModal from '$components/forms/EmailPreviewModal.svelte';
	import { toast } from '$components/ui/Toast.svelte';
	import { formatMoney } from '$lib/money.js';
	import { useUnsavedWarning } from '$lib/unsaved-warning.svelte.js';
	import { t } from '$lib/i18n/index.svelte.js';
	import { proposalBadgeVariant } from '$lib/select-options.js';
	import type { LineItem, Discount, ProposalStatus } from '$lib/types.js';
	import type { PageData, ActionData } from './$types.js';

	let { data, form }: { data: PageData; form: ActionData } = $props();
	const dirty = useUnsavedWarning();
	let p = $derived(data.proposal);
	let showEmailModal = $state(false);
	let showMoreMenu = $state(false);
	let showPreview = $state(false);
	let showRejectConfirm = $state(false);
	let showConvertConfirm = $state(false);
	let previewKey = $state(0);
	let previewContainerWidth = $state(400);

	let emailPreview = $derived({
		subject: data.emailTemplate.subject
			.replace(/{documentId}/g, p.documentId)
			.replace(/{clientName}/g, p.buyer?.name ?? '')
			.replace(/{amount}/g, formatMoney(p.totals.total, p.currency)),
		body: data.emailTemplate.body
			.replace(/{documentId}/g, p.documentId)
			.replace(/{clientName}/g, p.buyer?.name ?? '')
			.replace(/{amount}/g, formatMoney(p.totals.total, p.currency))
	});

	let loading = $state(false);
	let showDelete = $state(false);
	let clientId = $state(p.clientId);
	let pricingMode = $state<'net' | 'gross'>(p.pricingMode);
	let currency = $state(p.currency);
	let language = $state(p.language);
	let issueDate = $state(p.issueDate);
	let validUntil = $state(p.validUntil);
	let items = $state<LineItem[]>(structuredClone(p.items));
	let discounts = $state<Discount[]>(structuredClone(p.discounts));
	let introText = $state(p.introText);
	let notes = $state(p.notes);
	let footerText = $state(p.footerText);
	let templateId = $state(p.templateId);
	let templateOptionValues = $state<Record<string, unknown>>(structuredClone(p.templateOptions ?? {}));

	let selectedTemplate = $derived(data.templates.find((t) => t.id === templateId));

	// Snapshot of server state for dirty comparison
	let serverSnapshot = $state('');

	function buildSnapshot() {
		return JSON.stringify([clientId, pricingMode, currency, language, issueDate, validUntil,
			items, discounts, introText, notes, footerText, templateId, templateOptionValues]);
	}

	// Sync form state when server data changes
	// Skip sync if user has unsaved edits (e.g. status-only change reloaded data)
	let skipNextSync = $state(false);
	$effect(() => {
		void p; // track
		if (untrack(() => skipNextSync)) { skipNextSync = false; return; }
		clientId = p.clientId;
		pricingMode = p.pricingMode;
		currency = p.currency;
		language = p.language;
		issueDate = p.issueDate;
		validUntil = p.validUntil;
		items = structuredClone(p.items);
		discounts = structuredClone(p.discounts);
		introText = p.introText;
		notes = p.notes;
		footerText = p.footerText;
		templateId = p.templateId;
		templateOptionValues = structuredClone(p.templateOptions ?? {});
	});

	// Capture snapshot after sync — queueMicrotask ensures values settled
	$effect(() => {
		void p;
		queueMicrotask(() => { serverSnapshot = buildSnapshot(); });
	});

	// Derive dirty from snapshot comparison
	$effect(() => {
		const current = buildSnapshot();
		dirty.value = serverSnapshot !== '' && current !== serverSnapshot;
	});

	const clientOptions = data.clients.map((c) => ({ value: c.id, label: c.name }));
	const templateOptions = data.templates.map((t) => ({ value: t.id, label: t.name }));

	let saveForm = $state<HTMLFormElement>();
	let saveDataInput = $state<HTMLInputElement>();
	let statusForm = $state<HTMLFormElement>();
	let statusInput = $state<HTMLInputElement>();
	let deleteForm = $state<HTMLFormElement>();
	let duplicateForm = $state<HTMLFormElement>();
	let convertForm = $state<HTMLFormElement>();

	function handleSave() {
		if (loading || !saveDataInput || !saveForm) return;
		if (!clientId) { toast(t('validation.selectClient'), 'error'); return; }
		if (!items || items.length === 0) { toast(t('validation.atLeastOneItem'), 'error'); return; }
		saveDataInput.value = JSON.stringify({
			clientId, pricingMode, currency, language, issueDate, validUntil,
			items, discounts, introText, notes, footerText, templateId,
			templateOptions: templateOptionValues
		});
		saveForm.requestSubmit();
	}

	function handleStatusChange(status: ProposalStatus) {
		if (loading || !statusInput || !statusForm) return;
		statusInput.value = status;
		statusForm.requestSubmit();
	}
</script>

<svelte:window onkeydown={(e) => {
	if ((e.metaKey || e.ctrlKey) && e.key === 's') {
		e.preventDefault();
		handleSave();
	}
}} />
<svelte:head><title>{t('proposal.title')} {p.documentId} | ITCake</title></svelte:head>

<TopBar title="{t('proposal.title')} {p.documentId}">
	{#snippet children()}
		<Badge variant={proposalBadgeVariant(p.status)}>{t('status.' + p.status)}</Badge>
		<div class="flex gap-2">
			{#if p.status === 'draft'}
				<Button size="sm" disabled={loading} onclick={() => handleStatusChange('sent')}>{t('button.markSent')}</Button>
			{/if}
			{#if p.status === 'sent'}
				<Button size="sm" disabled={loading} onclick={() => handleStatusChange('accepted')}>{t('button.accept')}</Button>
				<span class="hidden sm:inline-flex">
					<Button size="sm" variant="danger" disabled={loading} onclick={() => showRejectConfirm = true}>{t('button.reject')}</Button>
				</span>
			{/if}
			{#if p.status === 'sent' || p.status === 'accepted'}
				<span class="hidden sm:inline-flex">
					<Button size="sm" disabled={loading} onclick={() => showConvertConfirm = true}>{t('button.convertToInvoice')}</Button>
				</span>
			{/if}
			<span class="hidden sm:inline-flex">
				<Button size="sm" variant="secondary" disabled={loading} onclick={() => showEmailModal = true}>{t('button.email')}</Button>
			</span>
			<a href="/api/proposals/{p.id}/pdf" target="_blank" class="hidden sm:inline-flex">
				<Button size="sm" variant="secondary">{t('button.pdf')}</Button>
			</a>
			<!-- More menu -->
			<div class="relative">
				<button type="button" class="inline-flex items-center justify-center rounded-lg border border-border bg-bg-card text-near-black px-2.5 py-1.5 text-sm font-medium hover:bg-bg transition-colors" onclick={() => showMoreMenu = !showMoreMenu} aria-expanded={showMoreMenu} aria-haspopup="menu" aria-label={t('misc.moreActions')}>
					<svg class="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24" stroke-width="2">
						<path stroke-linecap="round" stroke-linejoin="round" d="M12 5v.01M12 12v.01M12 19v.01M12 6a1 1 0 110-2 1 1 0 010 2zm0 7a1 1 0 110-2 1 1 0 010 2zm0 7a1 1 0 110-2 1 1 0 010 2z" />
					</svg>
				</button>
				{#if showMoreMenu}
					<button class="fixed inset-0 z-40" onclick={() => showMoreMenu = false} aria-label={t('misc.closeMenu')}></button>
					<!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
					<div class="absolute right-0 top-full mt-1 z-50 w-44 rounded-lg border border-border bg-bg-card shadow-lg py-1" role="menu" tabindex="-1"
						onkeydown={(e) => {
							if (e.key === 'Escape') { showMoreMenu = false; return; }
							if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
								e.preventDefault();
								const items = (e.currentTarget as HTMLElement).querySelectorAll<HTMLElement>('[role="menuitem"]:not([disabled])');
								const idx = Array.from(items).indexOf(document.activeElement as HTMLElement);
								const next = e.key === 'ArrowDown' ? (idx + 1) % items.length : (idx - 1 + items.length) % items.length;
								items[next]?.focus();
							}
						}}
					>
						<!-- Mobile-only: secondary actions collapsed from top bar -->
						{#if p.status === 'sent'}
							<button role="menuitem" tabindex="-1" class="sm:hidden flex w-full items-center gap-2 px-4 py-2 text-sm text-red hover:bg-bg/50 focus:bg-bg/50 outline-none text-left disabled:opacity-50"
								disabled={loading} onclick={() => { showMoreMenu = false; showRejectConfirm = true; }}>{t('button.reject')}</button>
						{/if}
						{#if p.status === 'sent' || p.status === 'accepted'}
							<button role="menuitem" tabindex="-1" class="sm:hidden flex w-full items-center gap-2 px-4 py-2 text-sm hover:bg-bg/50 focus:bg-bg/50 outline-none text-left disabled:opacity-50"
								disabled={loading} onclick={() => { showMoreMenu = false; showConvertConfirm = true; }}>{t('button.convertToInvoice')}</button>
						{/if}
						<button role="menuitem" tabindex="-1" class="sm:hidden flex w-full items-center gap-2 px-4 py-2 text-sm hover:bg-bg/50 focus:bg-bg/50 outline-none text-left disabled:opacity-50"
							disabled={loading} onclick={() => { showMoreMenu = false; showEmailModal = true; }}>{t('button.email')}</button>
						<a href="/api/proposals/{p.id}/pdf" target="_blank" role="menuitem" tabindex="-1" class="sm:hidden flex w-full items-center gap-2 px-4 py-2 text-sm hover:bg-bg/50 focus:bg-bg/50 outline-none text-left">{t('button.pdf')}</a>
						<div class="sm:hidden border-t border-border my-1"></div>
						<!-- Standard menu items (all screen sizes) -->
						<button role="menuitem" tabindex="-1" class="flex w-full items-center gap-2 px-4 py-2 text-sm hover:bg-bg/50 focus:bg-bg/50 outline-none text-left" onclick={() => { showMoreMenu = false; showPreview = !showPreview; if (showPreview) previewKey++; }}>{t('action.preview')}</button>
						<button role="menuitem" tabindex="-1" class="flex w-full items-center gap-2 px-4 py-2 text-sm hover:bg-bg/50 focus:bg-bg/50 outline-none text-left disabled:opacity-50" disabled={loading} onclick={() => { showMoreMenu = false; duplicateForm?.requestSubmit(); }}>{t('action.duplicate')}</button>
						<button role="menuitem" tabindex="-1" class="flex w-full items-center gap-2 px-4 py-2 text-sm text-red hover:bg-bg/50 focus:bg-bg/50 outline-none text-left disabled:opacity-50" disabled={loading} onclick={() => { showMoreMenu = false; showDelete = true; }}>{t('action.delete')}</button>
					</div>
				{/if}
			</div>
		</div>
	{/snippet}
</TopBar>

<div class="p-6 pb-20 lg:pb-6">
	<div class="grid grid-cols-1 gap-6 lg:grid-cols-3">
		<div class="lg:col-span-2 space-y-6">
			<Card class="space-y-4">
				<div class="grid grid-cols-1 gap-4 sm:grid-cols-2">
					<Select label={t('label.client')} bind:value={clientId}
						options={[{ value: '', label: t('placeholder.selectClient') }, ...clientOptions]} />
					<Select label={t('label.template')} bind:value={templateId} options={templateOptions} />
					<Select label={t('label.pricingMode')} bind:value={pricingMode}
						options={[{ value: 'net', label: t('option.netExclTax') }, { value: 'gross', label: t('option.grossInclTax') }]} />
					<Input type="date" label={t('label.issueDate')} bind:value={issueDate} />
					<Input type="date" label={t('label.validUntil')} bind:value={validUntil} />
				</div>
				{#if selectedTemplate && selectedTemplate.options.filter(o => o.type !== 'font').length > 0}
					<h3 class="text-sm font-medium text-near-black/70 mt-2">{t('section.templateOptions')}</h3>
					<TemplateOptionsEditor options={selectedTemplate.options.filter(o => o.type !== 'font')} bind:values={templateOptionValues} />
				{/if}
			</Card>
			<Card><RichTextArea label={t('label.introduction')} bind:value={introText} rows={3} /></Card>
			<Card>
				<h2 class="text-lg font-semibold mb-4">{t('section.lineItems')}</h2>
				<LineItemEditor bind:items {currency} defaultTaxRate={data.kleinunternehmer ? 0 : data.defaultTaxRate} catalogItems={data.catalogItems} />
			</Card>
			<Card class="space-y-4">
				<h2 class="text-lg font-semibold">{t('section.discounts')}</h2>
				<DiscountEditor bind:discounts {currency} />
			</Card>

			<Card class="space-y-4">
				<RichTextArea label={t('label.notes')} bind:value={notes} rows={3} />
				<RichTextArea label={t('label.footer')} bind:value={footerText} rows={2} />
			</Card>
		</div>
		<div class="space-y-6">
			<Card>
				<h2 class="text-lg font-semibold mb-4">{t('section.summary')}</h2>
				<InvoiceSummary {items} {discounts} {pricingMode} {currency} />
				<div class="mt-6 space-y-2">
					<Button class="w-full" {loading} onclick={handleSave}>{t('button.saveChanges')}</Button>
					<Button class="w-full" variant="secondary" onclick={() => { showPreview = !showPreview; if (showPreview) previewKey++; }}>
						{showPreview ? t('button.hidePreview') : t('button.showPreview')}
					</Button>
				</div>
			</Card>
			{#if showPreview}
				<Card>
					<div class="flex items-center justify-between mb-2">
						<h2 class="text-sm font-semibold">{t('misc.previewLabel')}</h2>
						<button class="text-xs text-cyan hover:text-cyan-dark" onclick={() => previewKey++}>{t('misc.refreshPreview')}</button>
					</div>
					<div
						class="relative w-full overflow-hidden rounded border border-border bg-bg-card"
						style="aspect-ratio: 210/297;"
						bind:clientWidth={previewContainerWidth}
					>
						{#key previewKey}
							<iframe
								src="/api/proposals/{p.id}/preview"
								class="absolute top-0 left-0 border-0 pointer-events-none"
								style="width: 793px; height: 1122px; transform: scale({previewContainerWidth / 793}); transform-origin: top left;"
								title={t('proposal.previewTitle')}
								tabindex="-1"
								sandbox="allow-same-origin"
							></iframe>
						{/key}
					</div>
					{#if dirty.value}
						<p class="text-xs text-near-black/60 mt-2">{t('proposal.saveFirstToPreview')}</p>
					{/if}
				</Card>
			{/if}
		</div>
	</div>
</div>

<!-- Floating save button on mobile -->
<div class="fixed bottom-4 left-4 right-4 z-30 lg:hidden">
	<Button class="w-full shadow-lg" {loading} onclick={handleSave}>{t('button.saveChanges')}</Button>
</div>

<ConfirmDialog
	bind:open={showRejectConfirm}
	title={t('dialog.rejectProposal')}
	message={t('dialog.rejectProposalMessage', { id: p.documentId })}
	confirmLabel={t('button.reject')}
	onconfirm={() => { if (!loading) handleStatusChange('rejected'); }}
	oncancel={() => showRejectConfirm = false}
/>

<ConfirmDialog
	bind:open={showConvertConfirm}
	title={t('dialog.convertToInvoice')}
	message={t('dialog.convertToInvoiceMessage', { id: p.documentId })}
	confirmLabel={t('dialog.convert')}
	onconfirm={() => { if (!loading) convertForm?.requestSubmit(); }}
	oncancel={() => showConvertConfirm = false}
/>

<ConfirmDialog
	bind:open={showDelete}
	title={t('dialog.deleteProposal')}
	message={t('dialog.deleteProposalMessage', { id: p.documentId })}
	confirmLabel={t('action.delete')}
	onconfirm={() => { if (!loading) deleteForm?.requestSubmit(); }}
	oncancel={() => showDelete = false}
/>

<form bind:this={saveForm} method="POST" action="?/update" class="hidden"
	use:enhance={() => {
		loading = true;
		return async ({ result, update }) => {
			loading = false;
			if (result.type === 'success') { toast(t('toast.proposalSaved')); previewKey++; }
			await update();
		};
	}}>
	<input bind:this={saveDataInput} name="data" type="hidden" />
</form>
<form bind:this={statusForm} method="POST" action="?/status" class="hidden"
	use:enhance={() => {
		loading = true;
		const wasDirty = dirty.value;
		return async ({ result, update }) => {
			loading = false;
			if (result.type === 'success') toast(t('toast.statusChanged'));
			else if (result.type === 'failure') toast(String((result.data as Record<string, unknown>)?.error ?? t('toast.failedChangeStatus')), 'error');
			if (wasDirty) skipNextSync = true;
			await update();
		};
	}}>
	<input bind:this={statusInput} name="status" type="hidden" />
</form>
<form bind:this={duplicateForm} method="POST" action="?/duplicate" class="hidden"
	use:enhance={() => {
		loading = true;
		return async ({ result, update }) => {
			loading = false;
			if (result.type === 'redirect') toast(t('toast.proposalDuplicated'));
			else if (result.type === 'error') toast(t('toast.networkError'), 'error');
			await update();
		};
	}}></form>
<form bind:this={convertForm} method="POST" action="?/convertToInvoice" class="hidden"
	use:enhance={() => {
		loading = true;
		return async ({ result, update }) => {
			loading = false;
			if (result.type === 'redirect') toast(t('toast.convertedToInvoice'));
			else if (result.type === 'error') toast(t('toast.networkError'), 'error');
			await update();
		};
	}}></form>
<form bind:this={deleteForm} method="POST" action="?/delete" class="hidden"
	use:enhance={() => {
		loading = true;
		return async ({ update }) => {
			loading = false;
			await update();
		};
	}}></form>

<EmailPreviewModal
	bind:open={showEmailModal}
	to={p.buyer?.email ?? ''}
	subject={emailPreview.subject}
	body={emailPreview.body}
	attachmentId={p.id}
	attachmentType="proposal"
	documentType={t('proposal.title')}
	fromEmail={data.fromEmail}
	onclose={() => showEmailModal = false}
/>
