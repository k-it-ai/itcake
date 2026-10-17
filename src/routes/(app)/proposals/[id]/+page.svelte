<script lang="ts">
	import { tick, untrack } from 'svelte';
	import { enhance } from '$app/forms';
	import TopBar from '#lib/components/shell/TopBar.svelte';
	import Btn from '#lib/components/ui/Btn.svelte';
	import Card from '#lib/components/ui/Card.svelte';
	import SectionHead from '#lib/components/ui/SectionHead.svelte';
	import StatusPill from '#lib/components/ui/StatusPill.svelte';
	import Input from '#components/ui/Input.svelte';
	import Select from '#components/ui/Select.svelte';
	import RichTextArea from '#components/ui/RichTextArea.svelte';
	import LineItemEditor from '#components/forms/LineItemEditor.svelte';
	import DiscountEditor from '#components/forms/DiscountEditor.svelte';
	import InvoiceSummary from '#components/invoice/InvoiceSummary.svelte';
	import ConfirmDialog from '#components/ui/ConfirmDialog.svelte';
	import EmailPreviewModal from '#components/forms/EmailPreviewModal.svelte';
	import { toast } from '#components/ui/Toast.svelte';
	import { formatMoney } from '#lib/money.js';
	import { useUnsavedWarning } from '#lib/unsaved-warning.svelte.js';
	import { t } from '#lib/i18n/index.svelte.js';
	import { proposalStatusTone } from '#lib/select-options.js';
	import { MoreHorizontal } from '#lib/icons/index.js';
	import type { LineItem, Discount, ProposalStatus } from '#lib/types.js';
	import type { PageData, ActionData } from './$types.js';

	let { data, form }: { data: PageData; form: ActionData } = $props();
	const dirty = useUnsavedWarning();
	let p = $derived(data.proposal);
	let showEmailModal = $state(false);
	let showMoreMenu = $state(false);
	let menuEl = $state<HTMLDivElement>();
	let showPreview = $state(false);
	let showConvertConfirm = $state(false);
	let showStatusConfirm = $state(false);
	let pendingStatus = $state<ProposalStatus | null>(null);
	let statusMenuOpen = $state(false);
	let statusMenuEl = $state<HTMLDivElement>();
	let statusTriggerEl = $state<HTMLDivElement>();
	let previewKey = $state(0);
	let previewContainerWidth = $state(400);

	const statusTransitions: Record<ProposalStatus, ProposalStatus[]> = {
		draft: ['sent'],
		sent: ['accepted', 'rejected', 'expired'],
		accepted: [],
		rejected: [],
		expired: [],
	};

	let availableStatusTransitions = $derived(statusTransitions[p.status] ?? []);

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
		statusTriggerEl?.querySelector<HTMLButtonElement>('button')?.focus();
	}

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
	let serverSnapshot = $state('');

	function buildSnapshot() {
		return JSON.stringify([clientId, pricingMode, currency, language, issueDate, validUntil,
			items, discounts, introText, notes, footerText]);
	}

	let skipNextSync = $state(false);
	$effect(() => {
		void p;
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
	});

	$effect(() => {
		void p;
		queueMicrotask(() => { serverSnapshot = buildSnapshot(); });
	});

	$effect(() => {
		const current = buildSnapshot();
		dirty.value = serverSnapshot !== '' && current !== serverSnapshot;
	});

	const clientOptions = data.clients.map((c) => ({ value: c.id, label: c.name }));

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
			items, discounts, introText, notes, footerText, templateId: p.templateId,
			templateOptions: p.templateOptions ?? {}
		});
		saveForm.requestSubmit();
	}

	function handleStatusChange(status: ProposalStatus) {
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
<svelte:head><title>{t('proposal.title')} {p.documentId} | ITCake</title></svelte:head>

<TopBar
	title="{t('proposal.title')} {p.documentId}"
	breadcrumb={[t('crumb.billing'), t('proposal.titlePlural'), p.documentId]}
	sub={p.buyer?.name ?? undefined}
>
	{#snippet right()}
		<!-- Status pill (with transition menu when applicable) -->
		<div class="relative">
			{#if availableStatusTransitions.length > 0}
				<div bind:this={statusTriggerEl}>
					<StatusPill
						tone={proposalStatusTone(p.status)}
						ariaLabel={t('aria.changeStatus', { status: t(`status.${p.status}`) })}
						onclick={() => statusMenuOpen ? closeStatusMenu() : openStatusMenu()}
					>{t(`status.${p.status}`)}</StatusPill>
				</div>
			{:else}
				<StatusPill tone={proposalStatusTone(p.status)} action={false}>{t(`status.${p.status}`)}</StatusPill>
			{/if}
			{#if statusMenuOpen}
				<!-- svelte-ignore a11y_no_static_element_interactions -->
				<div class="fixed inset-0 z-40" role="presentation" onclick={() => closeStatusMenu()}></div>
				<!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
				<div
					bind:this={statusMenuEl}
					class="absolute right-0 top-full z-50 mt-1 w-44 rounded-lg border bg-[var(--card)] py-1 shadow-pop"
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
					{#each availableStatusTransitions as status (status)}
						<button
							role="menuitem"
							tabindex="-1"
							class="flex w-full items-center gap-2 px-3 py-1.5 text-left text-[12.5px] outline-none hover:bg-[var(--line-2)] focus:bg-[var(--line-2)]"
							style="color:var(--ink)"
							onclick={() => { closeStatusMenu(); handleStatusChange(status); }}
						>
							<StatusPill tone={proposalStatusTone(status)} action={false}>{t(`status.${status}`)}</StatusPill>
						</button>
					{/each}
				</div>
			{/if}
		</div>

		<Btn variant="ghost" size="sm" disabled={loading} onclick={() => showEmailModal = true}>{t('button.email')}</Btn>

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
				<div
					bind:this={menuEl}
					class="absolute right-0 top-full z-50 mt-1 w-52 rounded-lg border bg-[var(--card)] py-1 shadow-pop"
					style="border-color:var(--line)"
					role="menu"
					tabindex="-1"
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
					{#if p.status === 'sent' || p.status === 'accepted'}
						<button role="menuitem" tabindex="-1" class="w-full px-3 py-1.5 text-left text-[12.5px] outline-none hover:bg-[var(--line-2)] focus:bg-[var(--line-2)] disabled:opacity-50"
							style="color:var(--ink)" disabled={loading} onclick={() => { showMoreMenu = false; showConvertConfirm = true; }}>{t('button.convertToInvoice')}</button>
					{/if}
					<button role="menuitem" tabindex="-1" class="w-full px-3 py-1.5 text-left text-[12.5px] outline-none hover:bg-[var(--line-2)] focus:bg-[var(--line-2)] disabled:opacity-50"
						style="color:var(--ink)" disabled={loading} onclick={() => { showMoreMenu = false; duplicateForm?.requestSubmit(); }}>{t('action.duplicate')}</button>
					<div class="my-1 border-t" style="border-color:var(--line)"></div>
					<button role="menuitem" tabindex="-1" class="w-full px-3 py-1.5 text-left text-[12.5px] outline-none hover:bg-[var(--bad-soft)] focus:bg-[var(--bad-soft)] disabled:opacity-50"
						style="color:#7a1a22" disabled={loading} onclick={() => { showMoreMenu = false; showDelete = true; }}>{t('action.delete')}</button>
				</div>
			{/if}
		</div>
	{/snippet}
</TopBar>

<div class="p-5 pb-20 lg:pb-5">
	<div class="grid grid-cols-1 gap-4 lg:grid-cols-3">
		<div class="space-y-4 lg:col-span-2">
			<Card padding={20}>
				<div class="grid grid-cols-1 gap-4 sm:grid-cols-2">
					<div>
						<Select label={t('label.client')} bind:value={clientId}
							options={[{ value: '', label: t('placeholder.selectClient') }, ...clientOptions]} />
						<a href="/clients/new" class="mt-1 inline-block text-[11.5px] underline" style="color:var(--brand-ink)">{t('misc.newClient')}</a>
					</div>
					<Select label={t('label.pricingMode')} bind:value={pricingMode}
						options={[{ value: 'net', label: t('option.netExclTax') }, { value: 'gross', label: t('option.grossInclTax') }]} />
					<Input type="date" label={t('label.issueDate')} bind:value={issueDate} />
					<Input type="date" label={t('label.validUntil')} bind:value={validUntil} />
				</div>
			</Card>
			<Card padding={20}><RichTextArea label={t('label.introduction')} bind:value={introText} rows={3} /></Card>
			<Card padding={20}>
				<SectionHead title={t('section.lineItems')} />
				<LineItemEditor bind:items {currency} defaultTaxRate={data.kleinunternehmer ? 0 : data.defaultTaxRate} catalogItems={data.catalogItems} />
			</Card>
			<Card padding={20}>
				<SectionHead title={t('section.discounts')} />
				<DiscountEditor bind:discounts {currency} />
			</Card>
			<Card padding={20}>
				<div class="space-y-4">
					<RichTextArea label={t('label.notes')} bind:value={notes} rows={3} />
					<RichTextArea label={t('label.footer')} bind:value={footerText} rows={2} />
				</div>
			</Card>
		</div>
		<div class="space-y-4">
			<Card padding={20}>
				<SectionHead title={t('section.summary')} />
				<InvoiceSummary {items} {discounts} {pricingMode} {currency} />
				<div class="mt-6 space-y-2">
					<Btn variant="primary" class="w-full justify-center" disabled={loading} onclick={handleSave}>{t('button.saveChanges')}</Btn>
					<Btn variant="ghost" class="w-full justify-center" href="/api/proposals/{p.id}/pdf" target="_blank" rel="noopener noreferrer">{t('action.downloadPdf')}</Btn>
					<Btn
						variant="ghost"
						class="w-full justify-center"
						onclick={() => { showPreview = !showPreview; if (showPreview) previewKey++; }}
					>{showPreview ? t('button.hidePreview') : t('button.showPreview')}</Btn>
				</div>
			</Card>
			{#if showPreview}
				<Card padding={14}>
					<div class="mb-2 flex items-center justify-between">
						<h2 class="text-[13px] font-semibold" style="color:var(--ink)">{t('misc.previewLabel')}</h2>
						<button class="text-[11.5px] underline" style="color:var(--brand-ink)" onclick={() => previewKey++}>{t('misc.refreshPreview')}</button>
					</div>
					<div
						class="relative w-full overflow-hidden rounded border bg-[var(--card)]"
						style="aspect-ratio: 210/297;border-color:var(--line)"
						bind:clientWidth={previewContainerWidth}
					>
						{#key previewKey}
							<iframe
								src="/api/proposals/{p.id}/preview"
								class="pointer-events-none absolute left-0 top-0 border-0"
								style="width: 793px; height: 1122px; transform: scale({previewContainerWidth / 793}); transform-origin: top left;"
								title={t('proposal.previewTitle')}
								tabindex="-1"
								sandbox="allow-same-origin"
							></iframe>
						{/key}
					</div>
					{#if dirty.value}
						<p class="mt-2 text-[11px]" style="color:var(--muted)">{t('proposal.saveFirstToPreview')}</p>
					{/if}
				</Card>
			{/if}
		</div>
	</div>
</div>

<div class="fixed bottom-4 left-4 right-4 z-30 lg:hidden">
	<Btn variant="primary" class="w-full justify-center shadow-pop" disabled={loading} onclick={handleSave}>{t('button.saveChanges')}</Btn>
</div>

<ConfirmDialog
	bind:open={showStatusConfirm}
	title={t('dialog.changeStatus')}
	message={pendingStatus === 'sent' ? t('dialog.changeStatusMarkSent', { id: p.documentId }) : pendingStatus === 'rejected' ? t('dialog.rejectProposalMessage', { id: p.documentId }) : t('dialog.changeStatusGeneric', { status: pendingStatus ?? '' })}
	confirmLabel={pendingStatus === 'sent' ? t('dialog.confirmLabelMarkSent') : pendingStatus === 'rejected' ? t('button.reject') : t('dialog.changeStatus')}
	onconfirm={confirmStatusChange}
	oncancel={() => { showStatusConfirm = false; pendingStatus = null; }}
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
