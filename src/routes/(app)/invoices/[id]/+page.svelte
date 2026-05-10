<script lang="ts">
	import { tick, untrack } from 'svelte';
	import { enhance } from '$app/forms';
	import TopBar from '$lib/components/shell/TopBar.svelte';
	import Btn from '$lib/components/ui/Btn.svelte';
	import Card from '$lib/components/ui/Card.svelte';
	import StatusPill from '$lib/components/ui/StatusPill.svelte';
	import Tag from '$lib/components/ui/Tag.svelte';
	import SectionHead from '$lib/components/ui/SectionHead.svelte';
	import Input from '$components/ui/Input.svelte';
	import Select from '$components/ui/Select.svelte';
	import RichTextArea from '$components/ui/RichTextArea.svelte';
	import LineItemEditor from '$components/forms/LineItemEditor.svelte';
	import DiscountEditor from '$components/forms/DiscountEditor.svelte';
	import InvoiceSummary from '$components/invoice/InvoiceSummary.svelte';
	import { invoiceStatusTone } from '$lib/select-options.js';
	import ConfirmDialog from '$components/ui/ConfirmDialog.svelte';
	import EmailPreviewModal from '$components/forms/EmailPreviewModal.svelte';
	import { toast } from '$components/ui/Toast.svelte';
	import { formatMoney } from '$lib/money.js';
	import Toggle from '$components/ui/Toggle.svelte';
	import { t } from '$lib/i18n/index.svelte.js';
	import { formatDate } from '$lib/format-date.js';
	import { useUnsavedWarning } from '$lib/unsaved-warning.svelte.js';
	import { MoreHorizontal } from '$lib/icons';
	import type { LineItem, Discount, InvoiceStatus, RecurringFrequency } from '$lib/types.js';
	import type { PageData, ActionData } from './$types.js';

	let { data, form }: { data: PageData; form: ActionData } = $props();

	const dirty = useUnsavedWarning();
	let dateFormat = $derived(data.settings?.general?.dateFormat || 'DD/MM/YYYY');

	let inv = $derived(data.invoice);
	let editLocked = $derived(data.editLocked);
	let loading = $state(false);
	let showDelete = $state(false);
	let showStatusConfirm = $state(false);
	let pendingStatus = $state<InvoiceStatus | null>(null);
	let showEmailModal = $state(false);
	let showReminderModal = $state(false);
	let showMoreMenu = $state(false);
	let menuEl = $state<HTMLDivElement>();
	let statusMenuOpen = $state(false);
	let statusMenuEl = $state<HTMLDivElement>();
	let statusTriggerEl = $state<HTMLElement>();

	const statusTransitions: Record<InvoiceStatus, InvoiceStatus[]> = {
		draft: ['sent', 'cancelled'],
		sent: ['paid', 'overdue', 'cancelled'],
		overdue: ['paid', 'sent', 'cancelled'],
		paid: [],
		cancelled: [],
	};

	let availableStatusTransitions = $derived(statusTransitions[inv.status] ?? []);

	function openStatusMenu() {
		if (availableStatusTransitions.length === 0) return;
		statusMenuOpen = true;
		tick().then(() => {
			const first = statusMenuEl?.querySelector<HTMLElement>('[role="menuitem"]');
			first?.focus();
		});
	}

	function closeStatusMenu() {
		statusMenuOpen = false;
		statusTriggerEl?.focus();
	}
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
	let recurringEnabled = $state(inv.recurring?.enabled ?? false);
	let recurringFrequency = $state<RecurringFrequency>(inv.recurring?.frequency ?? 'monthly');
	let recurringCustomDays = $state(inv.recurring?.customIntervalDays ?? 30);
	let recurringEndDate = $state(inv.recurring?.endDate ?? '');
	let recurringNextRunDate = $state(inv.recurring?.nextRunDate ?? '');

	let serverSnapshot = $state('');

	function buildSnapshot() {
		return JSON.stringify([clientId, pricingMode, currency, language, issueDate, dueDate,
			items, discounts,
			notes, footerText,
			recurringEnabled, recurringFrequency, recurringCustomDays, recurringEndDate, recurringNextRunDate]);
	}

	let skipNextSync = $state(false);
	$effect(() => {
		void inv;
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
		recurringEnabled = inv.recurring?.enabled ?? false;
		recurringFrequency = inv.recurring?.frequency ?? 'monthly';
		recurringCustomDays = inv.recurring?.customIntervalDays ?? 30;
		recurringEndDate = inv.recurring?.endDate ?? '';
		recurringNextRunDate = inv.recurring?.nextRunDate ?? '';
	});

	$effect(() => {
		void inv;
		queueMicrotask(() => { serverSnapshot = buildSnapshot(); });
	});

	$effect(() => {
		const current = buildSnapshot();
		dirty.value = serverSnapshot !== '' && current !== serverSnapshot;
	});

	const clientOptions = data.clients.map((c) => ({ value: c.id, label: c.name }));

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
			notes, footerText, templateId: inv.templateId, templateOptions: inv.templateOptions ?? {},
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

<TopBar
	title="{documentLabel} {inv.documentId}"
	breadcrumb={['Billing', t('invoice.titlePlural'), inv.documentId]}
	sub={inv.buyer?.name ?? ''}
>
	{#snippet right()}
		<!-- Status pill with dropdown -->
		<div class="relative" bind:this={statusTriggerEl}>
			{#if availableStatusTransitions.length > 0}
				<StatusPill
					tone={invoiceStatusTone(inv.status)}
					ariaLabel={t('aria.changeStatus', { status: t('status.' + inv.status) })}
					onclick={() => statusMenuOpen ? closeStatusMenu() : openStatusMenu()}
				>
					{t(`status.${inv.status}`)}
				</StatusPill>
			{:else}
				<Tag tone={invoiceStatusTone(inv.status)}>{t(`status.${inv.status}`)}</Tag>
			{/if}
			{#if statusMenuOpen}
				<!-- svelte-ignore a11y_no_static_element_interactions -->
				<div class="fixed inset-0 z-40" role="presentation" onclick={() => closeStatusMenu()}></div>
				<!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
				<div
					bind:this={statusMenuEl}
					class="absolute right-0 top-full mt-1 z-50 w-40 rounded-md border bg-[var(--card)] shadow-pop py-1"
					style="border-color:var(--line)"
					role="menu"
					tabindex="-1"
					aria-label={t('aria.statusMenu')}
					onkeydown={(e) => {
						if (e.key === 'Escape') { closeStatusMenu(); return; }
						if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
							e.preventDefault();
							const items = (e.currentTarget as HTMLElement).querySelectorAll<HTMLElement>('[role="menuitem"]');
							const idx = Array.from(items).indexOf(document.activeElement as HTMLElement);
							const next = e.key === 'ArrowDown' ? (idx + 1) % items.length : (idx - 1 + items.length) % items.length;
							items[next]?.focus();
						}
					}}
				>
					{#each availableStatusTransitions as status}
						<button
							role="menuitem"
							tabindex="-1"
							class="flex items-center gap-2 w-full px-3 py-1.5 text-[12px] text-left outline-none transition-colors hover:bg-[var(--brand-soft)]"
							style="color:var(--ink)"
							onclick={() => { closeStatusMenu(); handleStatusChange(status); }}
						>
							<Tag tone={invoiceStatusTone(status)}>{t(`status.${status}`)}</Tag>
						</button>
					{/each}
				</div>
			{/if}
		</div>
		{#if isCreditNote}
			<Tag tone="accent">{t('badge.creditNote')}</Tag>
		{/if}
		<span class="hidden sm:inline-flex">
			<Btn variant="ghost" size="sm" disabled={loading} onclick={() => showEmailModal = true}>{t('button.email')}</Btn>
		</span>
		<!-- More menu -->
		<div class="relative">
			<Btn
				variant="ghost"
				size="sm"
				ariaLabel={t('misc.moreActions')}
				onclick={() => { showMoreMenu = !showMoreMenu; if (!showMoreMenu) return; tick().then(() => { const first = menuEl?.querySelector<HTMLElement>('[role="menuitem"]'); first?.focus(); }); }}
			>
				{#snippet icon()}<MoreHorizontal size={14} strokeWidth={1.6} />{/snippet}
			</Btn>
			{#if showMoreMenu}
				<!-- svelte-ignore a11y_no_static_element_interactions -->
				<div class="fixed inset-0 z-40" role="presentation" onclick={() => showMoreMenu = false}></div>
				<!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
				<div bind:this={menuEl} class="absolute right-0 top-full z-50 mt-1 w-48 rounded-md border bg-[var(--card)] py-1 shadow-pop" style="border-color:var(--line)" role="menu" tabindex="-1"
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
					<!-- Mobile-only: Email -->
					<button role="menuitem" tabindex="-1" class="sm:hidden w-full text-left px-4 py-2 text-[12px] outline-none transition-colors hover:bg-[var(--brand-soft)] disabled:opacity-50"
						style="color:var(--ink)"
						disabled={loading} onclick={() => { showMoreMenu = false; showEmailModal = true; }}>{t('button.email')}</button>
					<div class="sm:hidden border-t my-1" style="border-color:var(--line-2)"></div>
					{#if (inv.status === 'sent' || inv.status === 'overdue') && !isCreditNote}
						<button role="menuitem" tabindex="-1" class="w-full text-left px-4 py-2 text-[12px] outline-none transition-colors hover:bg-[var(--brand-soft)] disabled:opacity-50"
							style="color:var(--ink)"
							disabled={loading} onclick={() => { showMoreMenu = false; showReminderModal = true; }}>{t('button.sendReminder')}</button>
					{/if}
					{#if !isCreditNote}
						<button role="menuitem" tabindex="-1" class="w-full text-left px-4 py-2 text-[12px] outline-none transition-colors hover:bg-[var(--brand-soft)] disabled:opacity-50"
							style="color:var(--ink)"
							disabled={loading} onclick={() => { showMoreMenu = false; creditNoteForm?.requestSubmit(); }}>{t('button.createCreditNote')}</button>
					{/if}
					<button role="menuitem" tabindex="-1" class="w-full text-left px-4 py-2 text-[12px] outline-none transition-colors hover:bg-[var(--brand-soft)] disabled:opacity-50"
						style="color:var(--ink)"
						disabled={loading} onclick={() => { showMoreMenu = false; duplicateForm?.requestSubmit(); }}>{t('action.duplicate')}</button>
					<div class="border-t my-1" style="border-color:var(--line-2)"></div>
					<button role="menuitem" tabindex="-1" class="w-full text-left px-4 py-2 text-[12px] outline-none transition-colors hover:bg-[var(--bad-soft)] disabled:opacity-50"
						style="color:var(--bad)"
						disabled={loading} onclick={() => { showMoreMenu = false; showDelete = true; }}>{t('action.delete')}</button>
				</div>
			{/if}
		</div>
	{/snippet}
</TopBar>

<div class="p-5 pb-20 lg:pb-5">
	{#if editLocked}
		<div class="mb-4 rounded-md px-4 py-3 text-[12.5px] flex items-center gap-2" style="background:var(--warn-soft);color:#7a4400;border:1px solid #f0d8a0">
			<svg class="h-4 w-4 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24" stroke-width="2"><path stroke-linecap="round" stroke-linejoin="round" d="M12 15v2m-6 4h12a2 2 0 002-2v-6a2 2 0 00-2-2H6a2 2 0 00-2 2v6a2 2 0 002 2zm10-10V7a4 4 0 00-8 0v4h8z" /></svg>
			{t('help.editLockMessage', { status: t('status.' + inv.status) })}
		</div>
	{/if}
	{#if form?.error}
		<div role="alert" class="mb-4 rounded-md px-4 py-3 text-[12.5px]" style="background:var(--bad-soft);color:#7a1a22">{form.error}</div>
	{/if}

	<div class="grid grid-cols-1 gap-5 lg:grid-cols-3">
		<div class="lg:col-span-2 space-y-5">
			{#if isCreditNote && inv.linkedInvoiceId}
				<div class="rounded-md px-4 py-3 text-[12.5px]" style="background:var(--accent-soft);color:#7a4a00;border:1px solid #f0d8a0">
					{t('invoice.creditNoteForInvoice')} <a href="/invoices/{inv.linkedInvoiceId}" class="font-medium underline" style="color:var(--brand-ink)">{(inv.notes ?? '').match(/Credit note for (.+)/)?.[1] ?? inv.linkedInvoiceId}</a>
				</div>
			{/if}
			<Card padding={20} class="space-y-4">
				<SectionHead title={documentLabel} />
				<div class="grid grid-cols-1 gap-4 sm:grid-cols-2">
					<div>
						<Select label={t('label.client')} bind:value={clientId}
							options={[{ value: '', label: t('placeholder.selectClient') }, ...clientOptions]} />
						<a href="/clients/new" class="text-[11px] mt-1 inline-block" style="color:var(--brand)">{t('misc.newClient')}</a>
					</div>
					<Select label={t('label.pricingMode')} bind:value={pricingMode}
						options={[{ value: 'net', label: t('option.netExclTax') }, { value: 'gross', label: t('option.grossInclTax') }]} />
					<Input type="date" label={t('label.issueDate')} bind:value={issueDate} />
					<Input type="date" label={t('label.dueDate')} bind:value={dueDate} />
				</div>
			</Card>

			<Card padding={20}>
				<SectionHead title={t('section.lineItems')} />
				<LineItemEditor bind:items {currency} defaultTaxRate={data.kleinunternehmer ? 0 : data.defaultTaxRate} catalogItems={data.catalogItems} />
			</Card>

			<Card padding={20} class="space-y-4">
				<SectionHead title={t('section.discounts')} />
				<DiscountEditor bind:discounts {currency} />
			</Card>

			<Card padding={20} class="space-y-4">
				<RichTextArea label={t('label.notes')} bind:value={notes} rows={3} />
				<RichTextArea label={t('label.footer')} bind:value={footerText} rows={2} />
			</Card>

			{#if !isCreditNote}
			<Card padding={20} class="space-y-4">
				<SectionHead title={t('section.recurring')}>
					{#snippet right()}
						<Toggle bind:checked={recurringEnabled} label={t('label.enableRecurring')} />
					{/snippet}
				</SectionHead>
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
						<p class="text-[11px]" style="color:var(--muted)">{t('invoice.generatedSoFar', { count: inv.recurring.generatedInvoiceIds.length })}
							{#if inv.recurring.lastRunDate}{t('invoice.lastRun')}: {formatDate(inv.recurring.lastRunDate, dateFormat)}{/if}
						</p>
					{/if}
				{/if}
			</Card>
			{/if}
		</div>

		<div class="space-y-5">
			<Card padding={20}>
				<SectionHead title={t('section.summary')} />
				<InvoiceSummary {items} {discounts} {pricingMode} {currency} />
				<div class="mt-6 space-y-2">
					<Btn class="w-full justify-center" variant="primary" disabled={loading || editLocked} onclick={handleSave}>{editLocked ? t('button.locked') : t('button.saveChanges')}</Btn>
					<Btn class="w-full justify-center" variant="ghost" href="/api/invoices/{inv.id}/pdf" target="_blank" rel="noopener noreferrer">{t('action.downloadPdf')}</Btn>
					<Btn class="w-full justify-center" variant="ghost" onclick={() => { showPreview = !showPreview; if (showPreview) previewKey++; }}>
						{showPreview ? t('button.hidePreview') : t('button.showPreview')}
					</Btn>
				</div>
			</Card>
			{#if showPreview}
				<Card padding={14}>
					<div class="flex items-center justify-between mb-2">
						<h3 class="text-[12.5px] font-semibold" style="color:var(--ink)">{t('misc.previewLabel')}</h3>
						<button class="text-[11px]" style="color:var(--brand)" onclick={() => previewKey++}>{t('misc.refreshPreview')}</button>
					</div>
					<a
						href="/invoices/{inv.id}/preview"
						class="group relative block w-full overflow-hidden rounded border bg-[var(--card)]"
						style="aspect-ratio: 210/297; border-color:var(--line)"
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
							<span class="rounded-md px-3 py-1.5 text-[11.5px] font-medium opacity-0 group-hover:opacity-100 transition-opacity shadow-pop" style="background:var(--card);color:var(--ink)">{t('misc.openPreview')}</span>
						</div>
					</a>
					{#if dirty.value}
					<p class="text-[11px] mt-2" style="color:var(--muted)">{t('help.saveToUpdatePreview')}</p>
				{/if}
				</Card>
			{/if}
		</div>
	</div>
</div>

<!-- Floating save button on mobile -->
<div class="fixed bottom-4 left-4 right-4 z-30 lg:hidden">
	<Btn class="w-full justify-center shadow-pop" variant="primary" disabled={loading || editLocked} onclick={handleSave}>{editLocked ? t('button.locked') : t('button.saveChanges')}</Btn>
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
