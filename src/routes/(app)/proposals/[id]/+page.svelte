<script lang="ts">
	import { tick, untrack } from 'svelte';
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
	let menuEl = $state<HTMLDivElement>();
	let showPreview = $state(false);
	let showConvertConfirm = $state(false);
	let showStatusConfirm = $state(false);
	let pendingStatus = $state<ProposalStatus | null>(null);
	let statusMenuOpen = $state(false);
	let statusMenuEl = $state<HTMLDivElement>();
	let statusTriggerEl = $state<HTMLButtonElement>();
	let previewKey = $state(0);
	let previewContainerWidth = $state(400);

	const badgeClasses: Record<string, string> = {
		draft: 'bg-near-black/10 text-near-black/80 dark:bg-white/10 dark:text-white/80',
		sent: 'bg-cyan-light text-cyan-dark dark:bg-cyan-900/30 dark:text-cyan-300',
		accepted: 'bg-green-100 text-green-800 dark:bg-green-900/30 dark:text-green-300',
		rejected: 'bg-red/10 text-red-dark dark:bg-red-900/30 dark:text-red-300',
		expired: 'bg-amber-100 text-amber-800 dark:bg-amber-900/30 dark:text-amber-300',
	};

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
		statusTriggerEl?.focus();
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

<TopBar title="{t('proposal.title')} {p.documentId}" backHref="/proposals">
	{#snippet children()}
		<!-- Status badge with dropdown for status changes -->
		<div class="relative">
			{#if availableStatusTransitions.length > 0}
				<button
					bind:this={statusTriggerEl}
					class="inline-flex items-center gap-1 capitalize rounded-full px-2.5 py-0.5 text-xs font-medium cursor-pointer hover:ring-1 hover:ring-current/30 transition-shadow {badgeClasses[p.status] ?? badgeClasses.draft}"
					onclick={() => statusMenuOpen ? closeStatusMenu() : openStatusMenu()}
					aria-haspopup="true"
					aria-expanded={statusMenuOpen}
					aria-label={t('aria.changeStatus', { status: t(`status.${p.status}`) })}
				>
					{t(`status.${p.status}`)}
					<svg class="h-3 w-3" aria-hidden="true" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 9l-7 7-7-7" /></svg>
				</button>
			{:else}
				<Badge variant={proposalBadgeVariant(p.status)}>{t(`status.${p.status}`)}</Badge>
			{/if}
			{#if statusMenuOpen}
				<!-- svelte-ignore a11y_no_static_element_interactions -->
				<div class="fixed inset-0 z-40" role="presentation" onclick={() => closeStatusMenu()}></div>
				<!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
				<div
					bind:this={statusMenuEl}
					class="absolute right-0 top-full mt-1 z-50 w-40 rounded-lg border border-border bg-bg-card shadow-lg py-1"
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
							class="flex items-center gap-2 w-full px-3 py-1.5 text-sm text-near-black/80 hover:bg-bg/50 focus:bg-bg/50 text-left outline-none"
							onclick={() => { closeStatusMenu(); handleStatusChange(status); }}
						>
							<span class="inline-flex items-center capitalize rounded-full px-2 py-0.5 text-xs font-medium {badgeClasses[status] ?? badgeClasses.draft}">{t(`status.${status}`)}</span>
						</button>
					{/each}
				</div>
			{/if}
		</div>
		<!-- Action buttons -->
		<div class="flex gap-2">
			<span class="hidden sm:inline-flex">
				<Button size="sm" variant="secondary" disabled={loading} onclick={() => showEmailModal = true}>{t('button.email')}</Button>
			</span>
			<!-- More menu -->
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
					<div bind:this={menuEl} class="absolute right-0 top-full z-50 mt-1 w-48 rounded-lg border border-border bg-bg-card py-1 shadow-lg" role="menu" tabindex="-1"
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
						<button role="menuitem" tabindex="-1" class="sm:hidden w-full text-left px-4 py-2 text-sm text-near-black hover:bg-bg focus:bg-bg outline-none disabled:opacity-50"
							disabled={loading} onclick={() => { showMoreMenu = false; showEmailModal = true; }}>{t('button.email')}</button>
						<div class="sm:hidden border-t border-border my-1"></div>
						<!-- Document actions -->
						{#if p.status === 'sent' || p.status === 'accepted'}
							<button role="menuitem" tabindex="-1" class="w-full text-left px-4 py-2 text-sm text-near-black hover:bg-bg focus:bg-bg outline-none disabled:opacity-50"
								disabled={loading} onclick={() => { showMoreMenu = false; showConvertConfirm = true; }}>{t('button.convertToInvoice')}</button>
						{/if}
						<button role="menuitem" tabindex="-1" class="w-full text-left px-4 py-2 text-sm text-near-black hover:bg-bg focus:bg-bg outline-none disabled:opacity-50"
							disabled={loading} onclick={() => { showMoreMenu = false; duplicateForm?.requestSubmit(); }}>{t('action.duplicate')}</button>
						<div class="border-t border-border my-1"></div>
						<!-- Destructive -->
						<button role="menuitem" tabindex="-1" class="w-full text-left px-4 py-2 text-sm text-red hover:bg-bg focus:bg-bg outline-none disabled:opacity-50"
							disabled={loading} onclick={() => { showMoreMenu = false; showDelete = true; }}>{t('action.delete')}</button>
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
					<div>
						<Select label={t('label.client')} bind:value={clientId}
							options={[{ value: '', label: t('placeholder.selectClient') }, ...clientOptions]} />
						<a href="/clients/new" class="text-xs text-cyan hover:text-cyan-dark mt-1 inline-block">{t('misc.newClient')}</a>
					</div>
					<Select label={t('label.pricingMode')} bind:value={pricingMode}
						options={[{ value: 'net', label: t('option.netExclTax') }, { value: 'gross', label: t('option.grossInclTax') }]} />
					<Input type="date" label={t('label.issueDate')} bind:value={issueDate} />
					<Input type="date" label={t('label.validUntil')} bind:value={validUntil} />
				</div>
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
					<a href="/api/proposals/{p.id}/pdf" target="_blank" rel="noopener noreferrer" class="block">
						<Button class="w-full" variant="secondary">{t('action.downloadPdf')}</Button>
					</a>
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
