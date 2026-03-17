<script lang="ts">
	import { tick, untrack } from 'svelte';
	import { enhance } from '$app/forms';
	import TopBar from '$components/layout/TopBar.svelte';
	import Button from '$components/ui/Button.svelte';
	import Card from '$components/ui/Card.svelte';
	import Input from '$components/ui/Input.svelte';
	import Select from '$components/ui/Select.svelte';
	import RichTextArea from '$components/ui/RichTextArea.svelte';
	import LineItemEditor from '$components/forms/LineItemEditor.svelte';
	import DiscountEditor from '$components/forms/DiscountEditor.svelte';
	import TemplateOptionsEditor from '$components/forms/TemplateOptionsEditor.svelte';
	import InvoiceSummary from '$components/invoice/InvoiceSummary.svelte';
	import InvoiceStatusBadge from '$components/invoice/InvoiceStatusBadge.svelte';
	import Badge from '$components/ui/Badge.svelte';
	import ConfirmDialog from '$components/ui/ConfirmDialog.svelte';
	import EmailPreviewModal from '$components/forms/EmailPreviewModal.svelte';
	import { toast } from '$components/ui/Toast.svelte';
	import { formatMoney } from '$lib/money.js';
	import Toggle from '$components/ui/Toggle.svelte';
	import { t } from '$lib/i18n/index.svelte.js';
	import { useUnsavedWarning } from '$lib/unsaved-warning.svelte.js';
	import type { LineItem, Discount, InvoiceStatus, RecurringFrequency } from '$lib/types.js';
	import type { PageData, ActionData } from './$types.js';

	let { data, form }: { data: PageData; form: ActionData } = $props();

	const dirty = useUnsavedWarning();

	let inv = $derived(data.invoice);
	let loading = $state(false);
	let showDelete = $state(false);
	let showStatusConfirm = $state(false);
	let pendingStatus = $state<InvoiceStatus | null>(null);
	let showEmailModal = $state(false);
	let showReminderModal = $state(false);
	let showMoreMenu = $state(false);
	let menuEl = $state<HTMLDivElement>();
	let showPreview = $state(false);
	let previewKey = $state(0);
	let previewContainerWidth = $state(400);

	function resolveEmailPlaceholders(template: { subject: string; body: string }) {
		const amount = formatMoney(inv.totals.total, inv.currency);
		const replacements: [RegExp, string][] = [
			[/{documentId}/g, inv.documentId],
			[/{clientName}/g, inv.buyer?.name ?? ''],
			[/{amount}/g, amount]
		];
		const resolve = (s: string) => replacements.reduce((acc, [re, val]) => acc.replace(re, val), s);
		return { subject: resolve(template.subject), body: resolve(template.body) };
	}

	let emailPreview = $derived(resolveEmailPlaceholders(data.emailTemplate));
	let reminderPreview = $derived(resolveEmailPlaceholders(data.reminderTemplate));

	let clientId = $state(inv.clientId);
	let pricingMode = $state<'net' | 'gross'>(inv.pricingMode);
	let currency = $state(inv.currency);
	let language = $state(inv.language);
	let issueDate = $state(inv.issueDate);
	let dueDate = $state(inv.dueDate);
	let items = $state<LineItem[]>(structuredClone(inv.items));
	let discounts = $state<Discount[]>(structuredClone(inv.discounts));
	let notes = $state(inv.notes);
	let footerText = $state(inv.footerText);
	let templateId = $state(inv.templateId);
	let templateOptionValues = $state<Record<string, unknown>>(structuredClone(inv.templateOptions ?? {}));

	let selectedTemplate = $derived(data.templates.find((t) => t.id === templateId));

	// Recurring config
	let recurringEnabled = $state(inv.recurring?.enabled ?? false);
	let recurringFrequency = $state<RecurringFrequency>(inv.recurring?.frequency ?? 'monthly');
	let recurringCustomDays = $state(inv.recurring?.customIntervalDays ?? 30);
	let recurringEndDate = $state(inv.recurring?.endDate ?? '');
	let recurringNextRunDate = $state(inv.recurring?.nextRunDate ?? '');

	// Snapshot of server state for dirty comparison
	let serverSnapshot = $state('');

	function buildSnapshot() {
		return JSON.stringify([clientId, pricingMode, currency, language, issueDate, dueDate,
			items, discounts,
			notes, footerText, templateId, templateOptionValues,
			recurringEnabled, recurringFrequency, recurringCustomDays, recurringEndDate, recurringNextRunDate]);
	}

	// Sync form state when server data changes (after save/navigation)
	// Skip sync if user has unsaved edits (e.g. status-only change reloaded data)
	let skipNextSync = $state(false);
	$effect(() => {
		void inv; // track
		if (untrack(() => skipNextSync)) { skipNextSync = false; return; }
		clientId = inv.clientId;
		pricingMode = inv.pricingMode;
		currency = inv.currency;
		language = inv.language;
		issueDate = inv.issueDate;
		dueDate = inv.dueDate;
		items = structuredClone(inv.items);
		discounts = structuredClone(inv.discounts);
		notes = inv.notes;
		footerText = inv.footerText;
		templateId = inv.templateId;
		templateOptionValues = structuredClone(inv.templateOptions ?? {});
		recurringEnabled = inv.recurring?.enabled ?? false;
		recurringFrequency = inv.recurring?.frequency ?? 'monthly';
		recurringCustomDays = inv.recurring?.customIntervalDays ?? 30;
		recurringEndDate = inv.recurring?.endDate ?? '';
		recurringNextRunDate = inv.recurring?.nextRunDate ?? '';
	});

	// Capture snapshot after sync effect runs — runs in same batch, after writes settle
	$effect(() => {
		// Read inv to track server data changes
		void inv;
		// Use queueMicrotask so snapshot captures values AFTER the sync effect's writes
		queueMicrotask(() => { serverSnapshot = buildSnapshot(); });
	});

	// Derive dirty from snapshot comparison — no imperative writes, no effect loop
	$effect(() => {
		const current = buildSnapshot();
		dirty.value = serverSnapshot !== '' && current !== serverSnapshot;
	});

	const clientOptions = data.clients.map((c) => ({ value: c.id, label: c.name }));
	const templateOptions = data.templates.map((t) => ({ value: t.id, label: t.name }));

	let isCreditNote = $derived(inv.invoiceType === 'creditNote');
	let documentLabel = $derived(isCreditNote ? t('badge.creditNote') : t('invoice.title'));

	let saveForm = $state<HTMLFormElement>();
	let saveDataInput = $state<HTMLInputElement>();
	let statusForm = $state<HTMLFormElement>();
	let statusInput = $state<HTMLInputElement>();
	let deleteForm = $state<HTMLFormElement>();
	let duplicateForm = $state<HTMLFormElement>();
	let creditNoteForm = $state<HTMLFormElement>();

	function handleSave() {
		if (loading) return;
		if (!clientId) { toast(t('validation.selectClient'), 'error'); return; }
		if (!items || items.length === 0) { toast(t('validation.atLeastOneItem'), 'error'); return; }
		const recurring = recurringEnabled ? {
			enabled: true,
			frequency: recurringFrequency,
			customIntervalDays: recurringFrequency === 'custom' ? recurringCustomDays : null,
			nextRunDate: recurringNextRunDate || issueDate,
			endDate: recurringEndDate || null,
			lastRunDate: inv.recurring?.lastRunDate ?? null,
			generatedInvoiceIds: inv.recurring?.generatedInvoiceIds ?? []
		} : null;

		if (!saveDataInput || !saveForm) return;
		saveDataInput.value = JSON.stringify({
			clientId, pricingMode, currency, language,
			issueDate, dueDate,
			items, discounts,
			notes, footerText, templateId, templateOptions: templateOptionValues,
			recurring
		});
		saveForm.requestSubmit();
	}

	function handleStatusChange(status: InvoiceStatus) {
		pendingStatus = status;
		showStatusConfirm = true;
	}

	function confirmStatusChange() {
		if (loading || !pendingStatus || !statusInput || !statusForm) return;
		statusInput.value = pendingStatus;
		statusForm.requestSubmit();
		showStatusConfirm = false;
		pendingStatus = null;
	}
</script>

<svelte:window onkeydown={(e) => {
	if ((e.metaKey || e.ctrlKey) && e.key === 's') {
		e.preventDefault();
		handleSave();
	}
}} />
<svelte:head><title>{documentLabel} {inv.documentId} | ITCake</title></svelte:head>

<TopBar title="{documentLabel} {inv.documentId}">
	{#snippet children()}
		<InvoiceStatusBadge status={inv.status} />
		{#if isCreditNote}
			<Badge variant="warning">{t('badge.creditNote')}</Badge>
		{/if}
		<div class="flex gap-2">
			{#if inv.status === 'draft'}
				<Button size="sm" disabled={loading} onclick={() => handleStatusChange('sent')}>{t('button.markSent')}</Button>
			{/if}
			{#if inv.status === 'sent' || inv.status === 'overdue'}
				<Button size="sm" disabled={loading} onclick={() => handleStatusChange('paid')}>{t('button.markPaid')}</Button>
				{#if !isCreditNote}
					<span class="hidden sm:inline-flex">
						<Button size="sm" variant="secondary" disabled={loading} onclick={() => showReminderModal = true}>{t('button.sendReminder')}</Button>
					</span>
				{/if}
			{/if}
			<span class="hidden sm:inline-flex">
				<Button size="sm" variant="secondary" disabled={loading} onclick={() => showEmailModal = true}>{t('button.email')}</Button>
			</span>
			<a href="/api/invoices/{inv.id}/pdf" target="_blank" class="hidden sm:inline-flex">
				<Button size="sm" variant="secondary">{t('action.downloadPdf')}</Button>
			</a>
			<!-- More menu for secondary actions -->
			<div class="relative">
				<button
					type="button"
					class="inline-flex items-center justify-center font-medium rounded-lg transition-colors focus:outline-none focus:ring-2 focus:ring-offset-2 dark:focus:ring-offset-[var(--color-bg)] bg-bg-card text-near-black border border-border hover:bg-bg focus:ring-cyan px-3 py-1.5 text-sm"
					onclick={() => { showMoreMenu = !showMoreMenu; if (!showMoreMenu) return; tick().then(() => { const first = menuEl?.querySelector<HTMLElement>('[role="menuitem"]'); first?.focus(); }); }}
					aria-expanded={showMoreMenu}
					aria-haspopup="menu"
					aria-label={t('misc.moreActions')}
				>
					<svg class="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24" stroke-width="2">
						<path stroke-linecap="round" stroke-linejoin="round" d="M12 5v.01M12 12v.01M12 19v.01M12 6a1 1 0 110-2 1 1 0 010 2zm0 7a1 1 0 110-2 1 1 0 010 2zm0 7a1 1 0 110-2 1 1 0 010 2z" />
					</svg>
				</button>
				{#if showMoreMenu}
					<!-- svelte-ignore a11y_no_static_element_interactions -->
					<div class="fixed inset-0 z-40" role="presentation" onclick={() => showMoreMenu = false}></div>
					<!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
					<div bind:this={menuEl} class="absolute right-0 top-full z-50 mt-1 w-44 rounded-lg border border-border bg-bg-card py-1 shadow-lg" role="menu" tabindex="-1"
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
						{#if (inv.status === 'sent' || inv.status === 'overdue') && !isCreditNote}
							<button role="menuitem" tabindex="-1" class="sm:hidden w-full text-left px-4 py-2 text-sm text-near-black hover:bg-bg focus:bg-bg outline-none disabled:opacity-50"
								disabled={loading} onclick={() => { showMoreMenu = false; showReminderModal = true; }}>{t('button.sendReminder')}</button>
						{/if}
						<button role="menuitem" tabindex="-1" class="sm:hidden w-full text-left px-4 py-2 text-sm text-near-black hover:bg-bg focus:bg-bg outline-none disabled:opacity-50"
							disabled={loading} onclick={() => { showMoreMenu = false; showEmailModal = true; }}>{t('button.email')}</button>
						<a href="/api/invoices/{inv.id}/pdf" target="_blank" role="menuitem" tabindex="-1" class="sm:hidden block px-4 py-2 text-sm text-near-black hover:bg-bg focus:bg-bg outline-none">{t('action.downloadPdf')}</a>
						<div class="sm:hidden border-t border-border my-1"></div>
						<!-- Standard menu items (all screen sizes) -->
						<a href="/invoices/{inv.id}/preview" role="menuitem" tabindex="-1" class="block px-4 py-2 text-sm text-near-black hover:bg-bg focus:bg-bg outline-none">{t('action.preview')}</a>
						{#if !isCreditNote}
							<button role="menuitem" tabindex="-1" class="w-full text-left px-4 py-2 text-sm text-near-black hover:bg-bg focus:bg-bg outline-none disabled:opacity-50"
								disabled={loading} onclick={() => { showMoreMenu = false; creditNoteForm?.requestSubmit(); }}>{t('button.createCreditNote')}</button>
						{/if}
						<button role="menuitem" tabindex="-1" class="w-full text-left px-4 py-2 text-sm text-near-black hover:bg-bg focus:bg-bg outline-none disabled:opacity-50"
							disabled={loading} onclick={() => { showMoreMenu = false; duplicateForm?.requestSubmit(); }}>{t('action.duplicate')}</button>
						<button role="menuitem" tabindex="-1" class="w-full text-left px-4 py-2 text-sm text-red hover:bg-bg focus:bg-bg outline-none disabled:opacity-50"
							disabled={loading} onclick={() => { showMoreMenu = false; showDelete = true; }}>{t('action.delete')}</button>
					</div>
				{/if}
			</div>
		</div>
	{/snippet}
</TopBar>

<div class="p-6 pb-20 lg:pb-6">
	{#if data.editLocked}
		<div class="mb-4 rounded-lg bg-amber-50 dark:bg-amber-900/20 border border-amber-200 dark:border-amber-800 px-4 py-3 text-sm text-amber-800 dark:text-amber-300 flex items-center gap-2">
			<svg class="h-4 w-4 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24" stroke-width="2"><path stroke-linecap="round" stroke-linejoin="round" d="M12 15v2m-6 4h12a2 2 0 002-2v-6a2 2 0 00-2-2H6a2 2 0 00-2 2v6a2 2 0 002 2zm10-10V7a4 4 0 00-8 0v4h8z" /></svg>
			{t('help.editLockMessage', { status: inv.status })}
		</div>
	{/if}
	{#if form?.error}
		<div role="alert" class="mb-4 rounded-lg bg-red/10 px-4 py-3 text-sm text-red-dark dark:text-red-300">{form.error}</div>
	{/if}

	<div class="grid grid-cols-1 gap-6 lg:grid-cols-3">
		<div class="lg:col-span-2 space-y-6">
			{#if isCreditNote && inv.linkedInvoiceId}
				<div class="rounded-lg bg-amber-50 dark:bg-amber-900/20 border border-amber-200 dark:border-amber-800 px-4 py-3 text-sm text-amber-800 dark:text-amber-300">
					{t('invoice.creditNoteForInvoice')} <a href="/invoices/{inv.linkedInvoiceId}" class="text-cyan hover:underline font-medium">{(inv.notes ?? '').match(/Credit note for (.+)/)?.[1] ?? inv.linkedInvoiceId}</a>
				</div>
			{/if}
			<Card class="space-y-4">
				<h2 class="text-lg font-semibold">{documentLabel}</h2>
				<div class="grid grid-cols-1 gap-4 sm:grid-cols-2">
					<Select label={t('label.client')} bind:value={clientId}
						options={[{ value: '', label: t('placeholder.selectClient') }, ...clientOptions]} />
					<Select label={t('label.template')} bind:value={templateId} options={templateOptions} />
					<Select label={t('label.pricingMode')} bind:value={pricingMode}
						options={[{ value: 'net', label: t('option.netExclTax') }, { value: 'gross', label: t('option.grossInclTax') }]} />
					<Input type="date" label={t('label.issueDate')} bind:value={issueDate} />
					<Input type="date" label={t('label.dueDate')} bind:value={dueDate} />
				</div>
				{#if selectedTemplate && selectedTemplate.options.filter(o => o.type !== 'font').length > 0}
					<h3 class="text-sm font-medium text-near-black/70 mt-2">{t('section.templateOptions')}</h3>
					<TemplateOptionsEditor options={selectedTemplate.options.filter(o => o.type !== 'font')} bind:values={templateOptionValues} />
				{/if}
			</Card>

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

			{#if !isCreditNote}
			<Card class="space-y-4">
				<div class="flex items-center justify-between">
					<h2 class="text-lg font-semibold">{t('section.recurring')}</h2>
					<Toggle bind:checked={recurringEnabled} label={t('label.enableRecurring')} />
				</div>
				{#if recurringEnabled}
					<div class="grid grid-cols-1 gap-4 sm:grid-cols-2">
						<Select label={t('label.frequency')} bind:value={recurringFrequency}
							options={[
								{ value: 'weekly', label: t('option.weekly') },
								{ value: 'monthly', label: t('option.monthly') },
								{ value: 'quarterly', label: t('option.quarterly') },
								{ value: 'yearly', label: t('option.yearly') },
								{ value: 'custom', label: t('option.customInterval') }
							]} />
						{#if recurringFrequency === 'custom'}
							<Input type="number" label={t('label.customInterval')} bind:value={recurringCustomDays} />
						{/if}
						<Input type="date" label={t('label.nextRunDate')} bind:value={recurringNextRunDate} />
						<Input type="date" label={t('label.endDate')} bind:value={recurringEndDate} />
					</div>
					{#if inv.recurring?.generatedInvoiceIds?.length}
						<p class="text-xs text-near-black/60">{t('invoice.generatedSoFar', { count: inv.recurring.generatedInvoiceIds.length })}
							{#if inv.recurring.lastRunDate}{t('invoice.lastRun')}: {inv.recurring.lastRunDate}{/if}
						</p>
					{/if}
				{/if}
			</Card>
			{/if}
		</div>

		<div class="space-y-6">
			<Card>
				<h2 class="text-lg font-semibold mb-4">{t('section.summary')}</h2>
				<InvoiceSummary {items} {discounts} {pricingMode} {currency} />
				<div class="mt-6 space-y-2">
					<Button class="w-full" {loading} disabled={data.editLocked} onclick={handleSave}>{data.editLocked ? t('button.locked') : t('button.saveChanges')}</Button>
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
					<a
						href="/invoices/{inv.id}/preview"
						class="group relative block w-full overflow-hidden rounded border border-border bg-bg-card"
						style="aspect-ratio: 210/297;"
						bind:clientWidth={previewContainerWidth}
					>
						{#key previewKey}
							<iframe
								src="/api/invoices/{inv.id}/preview"
								class="absolute top-0 left-0 border-0 pointer-events-none"
								style="width: 793px; height: 1122px; transform: scale({previewContainerWidth / 793}); transform-origin: top left;"
								title={t('invoice.previewTitle')}
								tabindex="-1"
								sandbox="allow-same-origin"
							></iframe>
						{/key}
						<div class="absolute inset-0 flex items-center justify-center bg-black/0 group-hover:bg-black/10 transition-colors">
							<span class="rounded-lg bg-bg-card/90 px-3 py-1.5 text-xs font-medium text-near-black shadow opacity-0 group-hover:opacity-100 transition-opacity">{t('misc.openPreview')}</span>
						</div>
					</a>
					{#if dirty.value}
					<p class="text-xs text-near-black/60 mt-2">{t('help.saveToUpdatePreview')}</p>
				{/if}
				</Card>
			{/if}
		</div>
	</div>
</div>

<!-- Floating save button on mobile -->
<div class="fixed bottom-4 left-4 right-4 z-30 lg:hidden">
	<Button class="w-full shadow-lg" {loading} disabled={data.editLocked} onclick={handleSave}>{data.editLocked ? t('button.locked') : t('button.saveChanges')}</Button>
</div>

<ConfirmDialog
	bind:open={showDelete}
	title={t('dialog.deleteInvoice', { label: documentLabel })}
	message={t('dialog.deleteInvoiceMessage', { label: documentLabel.toLowerCase(), id: inv.documentId })}
	confirmLabel={t('action.delete')}
	onconfirm={() => { if (!loading) deleteForm?.requestSubmit(); }}
	oncancel={() => showDelete = false}
/>

<ConfirmDialog
	bind:open={showStatusConfirm}
	title={t('dialog.changeStatus')}
	message={pendingStatus === 'sent' ? t('dialog.changeStatusMarkSent', { id: inv.documentId }) : pendingStatus === 'paid' ? t('dialog.changeStatusMarkPaid', { id: inv.documentId }) : t('dialog.changeStatusGeneric', { status: pendingStatus ?? '' })}
	confirmLabel={pendingStatus === 'sent' ? t('dialog.confirmLabelMarkSent') : pendingStatus === 'paid' ? t('dialog.confirmLabelMarkPaid') : pendingStatus === 'cancelled' ? t('dialog.confirmLabelCancelInvoice') : t('dialog.changeStatus')}
	onconfirm={confirmStatusChange}
	oncancel={() => { showStatusConfirm = false; pendingStatus = null; }}
/>

<form bind:this={saveForm} method="POST" action="?/update" class="hidden"
	use:enhance={() => {
		loading = true;
		return async ({ result, update }) => {
			loading = false;
			if (result.type === 'success') { toast(t('toast.invoiceSaved')); previewKey++; }
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
			if (result.type === 'redirect') toast(t('toast.invoiceDuplicated'));
			else if (result.type === 'error') toast(t('toast.networkError'), 'error');
			await update();
		};
	}}></form>
<form bind:this={creditNoteForm} method="POST" action="?/creditNote" class="hidden"
	use:enhance={() => {
		loading = true;
		return async ({ result, update }) => {
			loading = false;
			if (result.type === 'redirect') toast(t('toast.creditNoteCreated'));
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
	to={inv.buyer?.email ?? ''}
	subject={emailPreview.subject}
	body={emailPreview.body}
	attachmentId={inv.id}
	attachmentType="invoice"
	documentType={documentLabel}
	fromEmail={data.fromEmail}
	onclose={() => showEmailModal = false}
/>

<EmailPreviewModal
	bind:open={showReminderModal}
	to={inv.buyer?.email ?? ''}
	subject={reminderPreview.subject}
	body={reminderPreview.body}
	attachmentId={inv.id}
	attachmentType="invoice"
	documentType={t('misc.reminder')}
	fromEmail={data.fromEmail}
	onclose={() => showReminderModal = false}
/>
