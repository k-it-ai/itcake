<script lang="ts">
	import TopBar from '$lib/components/shell/TopBar.svelte';
	import Card from '$lib/components/ui/Card.svelte';
	import Btn from '$lib/components/ui/Btn.svelte';
	import EmptyState from '$lib/components/ui/EmptyState.svelte';
	import Input from '$components/ui/Input.svelte';
	import Select from '$components/ui/Select.svelte';
	import TextArea from '$components/ui/TextArea.svelte';
	import ConfirmDialog from '$components/ui/ConfirmDialog.svelte';
	import MfaSection from '$components/settings/MfaSection.svelte';
	import BackupSection from '$components/settings/BackupSection.svelte';
	import RemoteDesktopSection from '$components/settings/RemoteDesktopSection.svelte';
	import AlertRulesSection from '$components/settings/AlertRulesSection.svelte';
	import CustomFieldsSection from '$components/settings/CustomFieldsSection.svelte';
	import SavedFiltersSection from '$components/settings/SavedFiltersSection.svelte';
	import AuditIntegritySection from '$components/settings/AuditIntegritySection.svelte';
	import { currencySelectOptions } from '$lib/currencies.js';
	import { interfaceLanguageOptions, dateFormatOptions, countrySelectOptions } from '$lib/select-options.js';
	import { toast } from '$components/ui/Toast.svelte';
	import { api, getErrorMessage } from '$lib/api.js';
	import { t } from '$lib/i18n/index.svelte.js';
	import { previewIdFormat } from '$lib/id-format.js';
	import { useUnsavedWarning } from '$lib/unsaved-warning.svelte.js';
	import { invalidateAll } from '$app/navigation';
	import { onMount } from 'svelte';
	import type { PageData } from './$types.js';

	let { data }: { data: PageData } = $props();

	const dirty = useUnsavedWarning();

	interface SettingsItem {
		id: string;
		tKey: string;
	}
	interface SettingsGroup {
		id: string;
		tKey: string;
		items: SettingsItem[];
	}

	const groups: SettingsGroup[] = [
		{
			id: 'workspace',
			tKey: 'settings.groupWorkspace',
			items: [
				{ id: 'general', tKey: 'settings.general' },
				{ id: 'company', tKey: 'settings.company' },
				{ id: 'documents', tKey: 'settings.documents' },
				{ id: 'template', tKey: 'template.title' },
				{ id: 'emails', tKey: 'settings.emails' },
				{ id: 'advanced', tKey: 'settings.advanced' }
			]
		},
		{
			id: 'security',
			tKey: 'settings.groupSecurity',
			items: [
				{ id: 'password', tKey: 'settings.changePassword' },
				{ id: 'mfa', tKey: 'settings.mfa' },
				{ id: 'backups', tKey: 'settings.backups' },
				{ id: 'audit-integrity', tKey: 'audit.title' }
			]
		},
		{
			id: 'operations',
			tKey: 'settings.groupOperations',
			items: [
				{ id: 'remote-desktop', tKey: 'rd.title' },
				{ id: 'alert-rules', tKey: 'alert.title' },
				{ id: 'custom-fields', tKey: 'customField.title' },
				{ id: 'saved-filters', tKey: 'savedFilter.title' }
			]
		}
	];
	const allItems = $derived(groups.flatMap((g) => g.items));

	let activeSection = $state('general');
	const activeItem = $derived(allItems.find((i) => i.id === activeSection) ?? allItems[0]);
	const activeGroup = $derived(
		groups.find((g) => g.items.some((i) => i.id === activeSection)) ?? groups[0]
	);

	onMount(() => {
		const hash = window.location.hash.slice(1);
		if (hash && allItems.some((i) => i.id === hash)) {
			activeSection = hash;
		}
	});

	function selectSection(id: string) {
		activeSection = id;
		history.replaceState({}, '', `/settings#${id}`);
	}

	const g = data.settings.general;
	let genLanguage = $state(g.language);
	let genCurrency = $state(g.currency);
	let genDateFormat = $state(g.dateFormat);
	let genTimezone = $state(g.timezone);
	let genLoading = $state(false);

	let genMounted = $state(false);
	$effect(() => {
		void [genLanguage, genCurrency, genDateFormat, genTimezone];
		if (genMounted) dirty.value = true;
		else genMounted = true;
	});

	const timezoneOptions = [
		{ value: 'Europe/Amsterdam', label: 'Europe/Amsterdam' },
		{ value: 'Europe/Berlin', label: 'Europe/Berlin' },
		{ value: 'Europe/London', label: 'Europe/London' },
		{ value: 'Europe/Paris', label: 'Europe/Paris' },
		{ value: 'Europe/Zurich', label: 'Europe/Zurich' },
		{ value: 'Europe/Vienna', label: 'Europe/Vienna' },
		{ value: 'Europe/Brussels', label: 'Europe/Brussels' },
		{ value: 'Europe/Stockholm', label: 'Europe/Stockholm' },
		{ value: 'Europe/Helsinki', label: 'Europe/Helsinki' },
		{ value: 'Europe/Warsaw', label: 'Europe/Warsaw' },
		{ value: 'Europe/Budapest', label: 'Europe/Budapest' },
		{ value: 'Europe/Istanbul', label: 'Europe/Istanbul' },
		{ value: 'America/New_York', label: 'America/New York' },
		{ value: 'America/Chicago', label: 'America/Chicago' },
		{ value: 'America/Los_Angeles', label: 'America/Los Angeles' },
		{ value: 'Asia/Tokyo', label: 'Asia/Tokyo' },
		{ value: 'Australia/Sydney', label: 'Australia/Sydney' },
		{ value: 'UTC', label: 'UTC' },
	];

	async function saveGeneral(silent = false): Promise<boolean> {
		genLoading = true;
		try {
			await api.post('/api/settings', { section: 'general', data: { language: genLanguage, currency: genCurrency, dateFormat: genDateFormat, timezone: genTimezone } });
			if (!silent) { toast(t('toast.settingsSaved')); dirty.value = false; await invalidateAll(); }
			return true;
		} catch (e) { if (!silent) toast(getErrorMessage(e, t('toast.failedSave')), 'error'); return false; }
		finally { genLoading = false; }
	}

	const co = data.settings.company;
	let compName = $state(co.name);
	let compEmail = $state(co.email);
	let compPhone = $state(co.phone);
	let compWebsite = $state(co.website);
	let compTaxNumber = $state(co.taxNumber ?? '');
	let compVatNumber = $state(co.vatNumber);
	let compRegistrationNumber = $state(co.registrationNumber);
	let compStreet = $state(co.address?.street || '');
	let compCity = $state(co.address?.city || '');
	let compZip = $state(co.address?.zip || '');
	let compAddressState = $state(co.address?.state || '');
	let compCountry = $state(co.address?.country || '');
	let compBankName = $state(co.bankName);
	let compBankAccount = $state(co.bankAccount);
	let compBankIban = $state(co.bankIban);
	let compBankSwift = $state(co.bankSwift);
	let compLegalInfo = $state(co.legalInfo);
	let compLogoUrl = $state(co.logoUrl || '');
	let compLoading = $state(false);
	let compUploading = $state(false);

	let compMounted = $state(false);
	$effect(() => {
		void [compName, compEmail, compPhone, compWebsite, compTaxNumber, compVatNumber, compRegistrationNumber,
			compStreet, compCity, compZip, compAddressState, compCountry,
			compBankName, compBankAccount, compBankIban, compBankSwift, compLegalInfo];
		if (compMounted) dirty.value = true;
		else compMounted = true;
	});

	async function handleLogoUpload(e: Event) {
		const input = e.target as HTMLInputElement;
		const file = input.files?.[0];
		if (!file) return;

		compUploading = true;
		try {
			const formData = new FormData();
			formData.append('logo', file);
			const res = await fetch('/api/logo', { method: 'POST', body: formData });
			if (!res.ok) {
				const err = await res.json();
				throw new Error(err.message || 'Upload failed');
			}
			const result = await res.json();
			compLogoUrl = result.logoUrl;
			toast(t('toast.logoUploaded'));
		} catch (err) {
			toast(err instanceof Error ? err.message : t('toast.uploadFailed'), 'error');
		}
		compUploading = false;
	}

	let showRemoveLogoConfirm = $state(false);

	async function removeLogo() {
		const prev = compLogoUrl;
		compLogoUrl = '';
		try {
			await api.post('/api/settings', { section: 'company', data: { logoUrl: '' } });
			toast(t('toast.logoRemoved'));
		} catch {
			compLogoUrl = prev;
			toast(t('toast.failedRemoveLogo'), 'error');
		}
	}

	async function saveCompany(silent = false): Promise<boolean> {
		compLoading = true;
		try {
			await api.post('/api/settings', {
				section: 'company',
				data: {
					name: compName, email: compEmail, phone: compPhone, website: compWebsite,
					taxNumber: compTaxNumber, vatNumber: compVatNumber, registrationNumber: compRegistrationNumber,
					address: { street: compStreet, city: compCity, zip: compZip, state: compAddressState, country: compCountry },
					logoUrl: compLogoUrl, bankName: compBankName, bankAccount: compBankAccount,
					bankIban: compBankIban, bankSwift: compBankSwift, legalInfo: compLegalInfo
				}
			});
			if (!silent) { toast(t('toast.companySaved')); dirty.value = false; await invalidateAll(); }
			return true;
		} catch (e) { if (!silent) toast(getErrorMessage(e, t('toast.failedSave')), 'error'); return false; }
		finally { compLoading = false; }
	}

	const inv = data.settings.invoices;
	let invIdFormat = $state(inv.idFormat);
	let invNextNumber = $state(inv.nextNumber);
	let invDefaultNotes = $state(inv.defaultNotes);
	let invDefaultFooter = $state(inv.defaultFooter);
	let invDefaultPricingMode = $state(inv.defaultPricingMode);
	let invDefaultTaxRate = $state(inv.defaultTaxRate);
	let invDefaultPaymentTermDays = $state(inv.defaultPaymentTermDays);

	const prop = data.settings.proposals;
	let propIdFormat = $state(prop.idFormat);
	let propNextNumber = $state(prop.nextNumber);
	let propDefaultNotes = $state(prop.defaultNotes);
	let propDefaultFooter = $state(prop.defaultFooter);
	let propDefaultPricingMode = $state(prop.defaultPricingMode);
	let propDefaultTaxRate = $state(prop.defaultTaxRate);
	let propDefaultValidDays = $state(prop.defaultValidDays);

	let docLoading = $state(false);
	let tmplReplacing = $state(false);
	let tmplFileInput = $state<HTMLInputElement>();
	let tmplPreviewOpen = $state(false);

	async function handleTemplateReplace() {
		const file = tmplFileInput?.files?.[0];
		if (!file) return;
		if (file.size > 1_000_000) { toast(t('template.fileTooLarge'), 'error'); return; }
		tmplReplacing = true;
		try {
			const text = await file.text();
			let parsed: Record<string, unknown>;
			try { parsed = JSON.parse(text); } catch { toast(t('template.invalidJson'), 'error'); tmplReplacing = false; return; }
			if (typeof parsed.html === 'string' && parsed.html.length > 500_000) { toast(t('template.htmlTooLarge'), 'error'); tmplReplacing = false; return; }
			if (typeof parsed.css === 'string' && parsed.css.length > 500_000) { toast(t('template.cssTooLarge'), 'error'); tmplReplacing = false; return; }
			await api.post('/api/templates', {
				action: 'update', id: 'kossov-it',
				name: typeof parsed.name === 'string' ? parsed.name.slice(0, 200) : 'kossov-it',
				html: typeof parsed.html === 'string' ? parsed.html : undefined,
				css: typeof parsed.css === 'string' ? parsed.css : undefined,
				options: Array.isArray(parsed.options) ? parsed.options : undefined
			});
			toast(t('toast.saved'));
			await invalidateAll();
		} catch (e) {
			toast(getErrorMessage(e, t('toast.error')), 'error');
		}
		tmplReplacing = false;
		if (tmplFileInput) tmplFileInput.value = '';
	}

	let invIdPreview = $derived(previewIdFormat(invIdFormat, invNextNumber));
	let propIdPreview = $derived(previewIdFormat(propIdFormat, propNextNumber));

	let docMounted = $state(false);
	$effect(() => {
		void [invIdFormat, invNextNumber, invDefaultNotes, invDefaultFooter,
			invDefaultPricingMode, invDefaultTaxRate, invDefaultPaymentTermDays,
			propIdFormat, propNextNumber, propDefaultNotes, propDefaultFooter,
			propDefaultPricingMode, propDefaultTaxRate, propDefaultValidDays];
		if (docMounted) dirty.value = true;
		else docMounted = true;
	});

	const pricingModeOptions = [
		{ value: 'net', label: t('option.netExclTax') },
		{ value: 'gross', label: t('option.grossInclTax') }
	];

	async function saveDocuments(silent = false): Promise<boolean> {
		docLoading = true;
		try {
			await Promise.all([
				api.post('/api/settings', {
					section: 'invoices',
					data: {
						idFormat: invIdFormat, nextNumber: invNextNumber, defaultTemplate: 'kossov-it',
						defaultNotes: invDefaultNotes,
						defaultFooter: invDefaultFooter, defaultPricingMode: invDefaultPricingMode,
						defaultTaxRate: invDefaultTaxRate, defaultPaymentTermDays: invDefaultPaymentTermDays
					}
				}),
				api.post('/api/settings', {
					section: 'proposals',
					data: {
						idFormat: propIdFormat, nextNumber: propNextNumber, defaultTemplate: 'kossov-it',
						defaultNotes: propDefaultNotes,
						defaultFooter: propDefaultFooter, defaultPricingMode: propDefaultPricingMode,
						defaultTaxRate: propDefaultTaxRate, defaultValidDays: propDefaultValidDays
					}
				})
			]);
			if (!silent) { toast(t('toast.documentSettingsSaved')); dirty.value = false; await invalidateAll(); }
			return true;
		} catch (e) { if (!silent) toast(getErrorMessage(e, t('toast.failedSave')), 'error'); return false; }
		finally { docLoading = false; }
	}

	const em = data.settings.emails;
	let smtpHost = $state(em.smtp?.host || '');
	let smtpPort = $state(em.smtp?.port || 587);
	let smtpSecure = $state(em.smtp?.secure ? 'true' : 'false');
	let smtpUser = $state(em.smtp?.user || '');
	let smtpPass = $state('');
	let smtpPassChanged = $state(false);
	const hasExistingPass = data.hasSmtpPass ?? false;
	let smtpFrom = $state(em.smtp?.from || '');
	let smtpFromName = $state(em.smtp?.fromName || '');

	let invSubject = $state(em.invoiceEmail?.subject || '');
	let invBody = $state(em.invoiceEmail?.body || '');
	let cnSubject = $state(em.creditNoteEmail?.subject || '');
	let cnBody = $state(em.creditNoteEmail?.body || '');
	let propSubject = $state(em.proposalEmail?.subject || '');
	let propBody = $state(em.proposalEmail?.body || '');
	let remSubject = $state(em.reminderEmail?.subject || '');
	let remBody = $state(em.reminderEmail?.body || '');

	let emailLoading = $state(false);
	let emailTesting = $state(false);

	let emailMounted = $state(false);
	$effect(() => {
		void [smtpHost, smtpPort, smtpSecure, smtpUser, smtpPass, smtpFrom, smtpFromName,
			invSubject, invBody, cnSubject, cnBody, propSubject, propBody, remSubject, remBody];
		if (!emailMounted) { emailMounted = true; return; }
		dirty.value = true;
	});

	async function saveEmails(silent = false): Promise<boolean> {
		emailLoading = true;
		try {
			await api.post('/api/settings', {
				section: 'emails',
				data: {
					smtp: { host: smtpHost, port: smtpPort, secure: smtpSecure === 'true', user: smtpUser, pass: smtpPassChanged ? smtpPass : null, from: smtpFrom, fromName: smtpFromName },
					invoiceEmail: { subject: invSubject, body: invBody },
					creditNoteEmail: { subject: cnSubject, body: cnBody },
					proposalEmail: { subject: propSubject, body: propBody },
					reminderEmail: { subject: remSubject, body: remBody }
				}
			});
			if (!silent) { toast(t('toast.emailSettingsSaved')); dirty.value = false; await invalidateAll(); }
			return true;
		} catch (e) {
			if (!silent) toast(getErrorMessage(e, t('toast.failedSave')), 'error');
			return false;
		} finally {
			emailLoading = false;
		}
	}

	async function testConnection() {
		if (dirty.value) {
			const saved = await saveEmails();
			if (!saved) return;
		}
		emailTesting = true;
		try {
			const result = await api.post<{ ok: boolean; error?: string }>('/api/emails', { action: 'test' });
			if (result.ok) {
				toast(t('toast.connectionSuccessful'), 'success');
			} else {
				toast(result.error || t('toast.connectionFailed'), 'error');
			}
		} catch (e) { toast(getErrorMessage(e, t('toast.connectionFailed')), 'error'); }
		emailTesting = false;
	}

	const adv = data.settings.advanced;
	let advSepaQrEnabled = $state(adv.sepaQrEnabled);
	let advKleinunternehmer = $state(adv.kleinunternehmer ?? false);
	let advEditLock = $state(adv.editLock ?? 'none');
	let advLoading = $state(false);

	let pwCurrent = $state('');
	let pwNew = $state('');
	let pwConfirm = $state('');
	let pwLoading = $state(false);
	let pwError = $state('');

	async function handleChangePassword() {
		pwError = '';
		if (pwNew.length < 8) { pwError = t('settings.passwordTooShort'); return; }
		if (pwNew !== pwConfirm) { pwError = t('settings.passwordMismatch'); return; }
		pwLoading = true;
		try {
			await api.post('/api/auth/password', { currentPassword: pwCurrent, newPassword: pwNew });
			toast(t('settings.passwordChanged'));
			setTimeout(() => window.location.href = '/login', 1500);
		} catch (e) {
			pwError = getErrorMessage(e);
		} finally {
			pwLoading = false;
		}
	}

	let advMounted = $state(false);
	$effect(() => {
		void [advSepaQrEnabled, advKleinunternehmer, advEditLock];
		if (advMounted) dirty.value = true;
		else advMounted = true;
	});

	async function saveAdvanced(silent = false): Promise<boolean> {
		advLoading = true;
		try {
			await api.post('/api/settings', { section: 'advanced', data: { sepaQrEnabled: advSepaQrEnabled, kleinunternehmer: advKleinunternehmer, editLock: advEditLock } });
			if (!silent) { toast(t('toast.advancedSettingsSaved')); dirty.value = false; await invalidateAll(); }
			return true;
		} catch (e) { if (!silent) toast(getErrorMessage(e, t('toast.failedSave')), 'error'); return false; }
		finally { advLoading = false; }
	}

	let saveAllLoading = $state(false);
	async function saveAll() {
		saveAllLoading = true;
		const sectionNames = ['general', 'company', 'documents', 'advanced'] as const;
		const fns = [saveGeneral, saveCompany, saveDocuments, saveAdvanced];
		const failed: string[] = [];
		for (let i = 0; i < fns.length; i++) {
			const ok = await fns[i](true);
			if (!ok) failed.push(sectionNames[i]);
		}
		if (failed.length === 0) {
			toast(t('toast.settingsSaved'));
			dirty.value = false;
		} else {
			toast(`${t('toast.failedSave')} (${failed.join(', ')})`, 'error');
		}
		await invalidateAll();
		saveAllLoading = false;
	}

	interface BackupInfo {
		filename: string;
		size: number;
		createdAt: string;
	}

	let backups: BackupInfo[] = $state(data.backups);
	let bkpCreating = $state(false);
	let bkpDeletingFile = $state<string | null>(null);
	let bkpRestoringFile = $state<string | null>(null);
	let bkpConfirmDelete = $state(false);
	let bkpConfirmRestore = $state(false);
	let bkpPendingDeleteFile = $state('');
	let bkpPendingRestoreFile = $state('');
	let bkpRestorePreviewMessage = $state('');
	let bkpLoadingPreview = $state(false);

	function formatSize(bytes: number): string {
		if (bytes < 1024) return `${bytes} B`;
		if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
		return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
	}

	function formatDate(iso: string): string {
		const d = new Date(iso);
		return d.toLocaleDateString(undefined, {
			year: 'numeric', month: 'short', day: 'numeric',
			hour: '2-digit', minute: '2-digit'
		});
	}

	async function handleCreate() {
		bkpCreating = true;
		try {
			const backup = await api.post<BackupInfo>('/api/backups', { action: 'create' });
			backups = [backup, ...backups];
			toast(t('toast.backupCreated'));
		} catch (e) {
			toast(getErrorMessage(e, t('toast.failedCreateBackup')), 'error');
		}
		bkpCreating = false;
	}

	function promptDelete(filename: string) {
		bkpPendingDeleteFile = filename;
		bkpConfirmDelete = true;
	}

	async function handleDelete() {
		const filename = bkpPendingDeleteFile;
		bkpConfirmDelete = false;
		bkpDeletingFile = filename;
		try {
			await api.post('/api/backups', { action: 'delete', filename });
			backups = backups.filter((b) => b.filename !== filename);
			toast(t('toast.backupDeleted'));
		} catch (e) {
			toast(getErrorMessage(e, t('toast.failedDeleteBackup')), 'error');
		}
		bkpDeletingFile = null;
	}

	async function promptRestore(filename: string) {
		bkpPendingRestoreFile = filename;
		bkpLoadingPreview = true;
		bkpRestorePreviewMessage = '';
		try {
			const preview = await api.post<{
				backupTimestamp: string;
				documentsAtRisk: Record<string, number>;
				changesAtRisk: number;
				totalAtRisk: number;
			}>('/api/backups', { action: 'restore_preview', filename });

			if (preview.totalAtRisk > 0 || preview.changesAtRisk > 0) {
				const parts: string[] = [];
				for (const [type, count] of Object.entries(preview.documentsAtRisk)) {
					if (count > 0) parts.push(`${count} ${t('entityType.' + type) || type}${count > 1 ? 's' : ''}`);
				}
				if (preview.changesAtRisk > 0) parts.push(`${preview.changesAtRisk} ${t('backup.auditLogEntries')}`);
				bkpRestorePreviewMessage = `${t('dialog.restoreBackupMessage')}\n\n${t('backup.dataCreatedAfter', { date: formatDate(preview.backupTimestamp) })}\n${parts.join(', ')}.`;
			} else {
				bkpRestorePreviewMessage = t('dialog.restoreBackupMessage');
			}
		} catch {
			bkpRestorePreviewMessage = t('dialog.restoreBackupMessage');
		}
		bkpLoadingPreview = false;
		bkpConfirmRestore = true;
	}

	async function handleRestore() {
		const filename = bkpPendingRestoreFile;
		bkpConfirmRestore = false;
		const password = window.prompt(t('dialog.confirmPasswordForRestore') || 'Confirm password to restore') ?? '';
		if (!password) return;
		bkpRestoringFile = filename;
		try {
			await api.post('/api/backups', { action: 'restore', filename, password });
			toast(t('toast.backupRestoredReloading'));
			setTimeout(() => window.location.reload(), 1000);
		} catch (e) {
			toast(getErrorMessage(e, t('toast.failedRestoreBackup')), 'error');
		}
		bkpRestoringFile = null;
	}

	function handleDownload(filename: string) {
		const a = document.createElement('a');
		a.href = `/api/backups?download=${encodeURIComponent(filename)}`;
		a.download = filename;
		a.style.display = 'none';
		document.body.appendChild(a);
		a.click();
		document.body.removeChild(a);
	}

</script>

<svelte:head><title>{t('settings.title')} | ITCake</title></svelte:head>

<TopBar
	title={t('settings.title')}
	breadcrumb={['System', t(activeGroup.tKey), t(activeItem.tKey)]}
>
	{#snippet right()}
		<Btn variant="primary" size="sm" disabled={saveAllLoading} onclick={saveAll}>
			{saveAllLoading ? '…' : t('action.save')}
		</Btn>
	{/snippet}
</TopBar>

<div class="grid gap-4 p-5" style="grid-template-columns: 240px 1fr;">
	<!-- Left rail: groups + items -->
	<aside class="self-start">
		<Card padding={0}>
			<nav class="py-2" aria-label={t('settings.title')}>
				{#each groups as g, gi (g.id)}
					<div class={gi === 0 ? 'mt-1' : 'mt-3'}>
						<div class="px-3 py-1 text-[10.5px] uppercase tracking-wider" style="color:var(--muted)">
							{t(g.tKey)}
						</div>
						{#each g.items as it (it.id)}
							{@const active = it.id === activeSection}
							<button
								type="button"
								class="w-full text-left px-3 py-1.5 text-[12.5px] rounded-md transition-colors"
								style={active
									? 'background:var(--brand-soft); color:var(--brand-ink); font-weight:600'
									: 'background:transparent; color:var(--ink)'}
								onclick={() => selectSection(it.id)}
								aria-current={active ? 'page' : undefined}
							>{t(it.tKey)}</button>
						{/each}
					</div>
				{/each}
			</nav>
		</Card>
	</aside>

	<!-- Right pane -->
	<div class="space-y-4 min-w-0">
	{#if activeSection === 'general'}
	<section id="general">
		<h2 class="text-xl font-semibold mb-4">{t('settings.general')}</h2>
		<Card class="space-y-4">
			<h3 class="text-lg font-semibold">{t('section.interface')}</h3>
			<div class="grid grid-cols-1 gap-4 sm:grid-cols-2">
				<Select label={t('settings.interfaceLanguage')} bind:value={genLanguage} options={interfaceLanguageOptions} />
				<Select label={t('settings.defaultCurrency')} bind:value={genCurrency} options={currencySelectOptions} />
				<Select label={t('settings.dateFormat')} bind:value={genDateFormat} options={dateFormatOptions} />
				<Select label={t('settings.timezone')} bind:value={genTimezone} options={timezoneOptions} />
			</div>
		</Card>
	</section>
	{:else if activeSection === 'company'}
	<section id="company">
		<h2 class="text-xl font-semibold mb-4">{t('settings.company')}</h2>
		<div class="space-y-6">
			<Card class="space-y-4">
				<h3 class="text-lg font-semibold">{t('section.companyLogo')}</h3>
				<div class="flex items-center gap-4">
					<label class="cursor-pointer shrink-0">
						{#if compLogoUrl}
							<div class="h-16 w-16 rounded-lg border border-border bg-bg-card p-1 flex items-center justify-center hover:border-cyan transition-colors">
								<img src={compLogoUrl} alt={t('aria.companyLogo')} class="max-h-full max-w-full object-contain" />
							</div>
						{:else}
							<div class="h-16 w-16 rounded-lg border border-dashed border-border bg-bg flex items-center justify-center hover:border-cyan transition-colors">
								<svg class="h-6 w-6 text-near-black/25" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 16l4.586-4.586a2 2 0 012.828 0L16 16m-2-2l1.586-1.586a2 2 0 012.828 0L20 14m-6-6h.01M6 20h12a2 2 0 002-2V6a2 2 0 00-2-2H6a2 2 0 00-2 2v12a2 2 0 002 2z" /></svg>
							</div>
						{/if}
						<input type="file" accept="image/png,image/jpeg,image/webp" class="hidden" onchange={handleLogoUpload} disabled={compUploading} />
					</label>
					<div class="flex flex-col gap-1.5">
						<label class="cursor-pointer text-sm font-medium text-cyan hover:text-cyan-dark">
							{compUploading ? t('label.uploading') : t('settings.uploadLogo')}
							<input type="file" accept="image/png,image/jpeg,image/webp" class="hidden" onchange={handleLogoUpload} disabled={compUploading} />
						</label>
						{#if compLogoUrl}
							<button class="text-xs text-near-black/60 hover:text-red text-left" onclick={() => showRemoveLogoConfirm = true}>{t('button.remove')}</button>
						{/if}
						<p class="text-xs text-near-black/60">{t('help.logoFormat')}</p>
					</div>
				</div>
			</Card>

			<Card class="space-y-4">
				<h3 class="text-lg font-semibold">{t('section.companyInfo')}</h3>
				<div class="grid grid-cols-1 gap-4 sm:grid-cols-2">
					<Input label={t('settings.companyName')} bind:value={compName} />
					<Input label={t('settings.companyEmail')} type="email" bind:value={compEmail} />
					<Input label={t('settings.companyPhone')} bind:value={compPhone} />
					<Input label={t('settings.companyWebsite')} bind:value={compWebsite} />
				</div>

				<h4 class="font-medium pt-2">{t('section.address')}</h4>
				<div class="grid grid-cols-1 gap-4 sm:grid-cols-2">
					<Input label={t('settings.street')} bind:value={compStreet} class="sm:col-span-2" />
					<Input label={t('settings.city')} bind:value={compCity} />
					<Input label={t('settings.zip')} bind:value={compZip} />
					<Input label={t('settings.state')} bind:value={compAddressState} />
					<Select label={t('settings.country')} bind:value={compCountry} options={countrySelectOptions()} />
				</div>

				<h4 class="font-medium pt-2">{t('section.taxLegal')}</h4>
				<div class="grid grid-cols-1 gap-4 sm:grid-cols-2">
					<Input label={t('settings.taxNumber')} bind:value={compTaxNumber} />
					<Input label={t('settings.vatId')} bind:value={compVatNumber} />
					<Input label={t('settings.registrationNo')} bind:value={compRegistrationNumber} />
				</div>
				<TextArea label={t('settings.legalInfo')} bind:value={compLegalInfo} rows={2} />

				<h4 class="font-medium pt-2">{t('section.bankDetails')}</h4>
				<div class="grid grid-cols-1 gap-4 sm:grid-cols-2">
					<Input label={t('settings.bankName')} bind:value={compBankName} />
					<Input label={t('settings.accountHolder')} bind:value={compBankAccount} />
					<Input label={t('settings.iban')} bind:value={compBankIban} />
					<Input label={t('settings.bic')} bind:value={compBankSwift} />
				</div>

				</Card>
		</div>
	</section>
	{:else if activeSection === 'documents'}
	<section id="documents">
		<h2 class="text-xl font-semibold mb-4">{t('settings.documents')}</h2>
		<div class="space-y-6">
			<Card class="space-y-4">
				<h3 class="text-lg font-semibold">{t('section.invoiceDefaults')}</h3>

				<div>
					<Input label={t('settings.idFormat')} bind:value={invIdFormat} placeholder={'{YYYY}-{####}'} />
					<p class="text-xs text-near-black/60 mt-1">
						{t('help.idFormatTokens')}
					</p>
					{#if invIdFormat}
						<p class="text-xs text-cyan font-medium mt-1">{t('settings.previewIdFormat')}: {invIdPreview}</p>
					{/if}
				</div>
				<div class="grid grid-cols-1 gap-4 sm:grid-cols-2">
					<Input label={t('settings.nextNumber')} type="number" bind:value={invNextNumber} />
					<Select label={t('settings.defaultPricingMode')} bind:value={invDefaultPricingMode} options={pricingModeOptions} />
					<Input label={t('label.defaultTaxRatePercent')} type="number" bind:value={invDefaultTaxRate} />
					<Input label={t('label.paymentTermsDays')} type="number" bind:value={invDefaultPaymentTermDays} />
				</div>

				<TextArea label={t('settings.defaultNotes')} bind:value={invDefaultNotes} rows={2} />
				<TextArea label={t('settings.defaultFooter')} bind:value={invDefaultFooter} rows={2} />
			</Card>

			<Card class="space-y-4">
				<h3 class="text-lg font-semibold">{t('section.proposalDefaults')}</h3>

				<div>
					<Input label={t('settings.idFormat')} bind:value={propIdFormat} placeholder={'P-{YYYY}-{####}'} />
					<p class="text-xs text-near-black/60 mt-1">
						{t('help.sameTokensAsInvoices')}
					</p>
					{#if propIdFormat}
						<p class="text-xs text-cyan font-medium mt-1">{t('settings.previewIdFormat')}: {propIdPreview}</p>
					{/if}
				</div>
				<div class="grid grid-cols-1 gap-4 sm:grid-cols-2">
					<Input label={t('settings.nextNumber')} type="number" bind:value={propNextNumber} />
					<Select label={t('settings.defaultPricingMode')} bind:value={propDefaultPricingMode} options={pricingModeOptions} />
					<Input label={t('label.defaultTaxRatePercent')} type="number" bind:value={propDefaultTaxRate} />
					<Input label={t('label.validityDays')} type="number" bind:value={propDefaultValidDays} />
				</div>

				<TextArea label={t('settings.defaultNotes')} bind:value={propDefaultNotes} rows={2} />
				<TextArea label={t('settings.defaultFooter')} bind:value={propDefaultFooter} rows={2} />
			</Card>

			</div>
	</section>
	{:else if activeSection === 'template'}
	<section id="template">
		<h2 class="text-xl font-semibold mb-4">{t('template.title')}</h2>
		<Card class="space-y-4">
			<p class="text-sm text-near-black/60">{t('template.replaceDescription')}</p>
			<div class="flex items-center gap-4">
				<button type="button" onclick={() => tmplPreviewOpen = true} class="w-24 aspect-[210/297] bg-bg rounded border border-border flex items-center justify-center text-near-black/20 overflow-hidden relative shrink-0 hover:border-cyan transition-colors cursor-pointer" title={t('action.preview')}>
					<img
						src="/api/templates/kossov-it/thumbnail"
						alt="kossov-it"
						class="absolute inset-0 w-full h-full object-cover object-top"
						loading="lazy"
					/>
				</button>
				<div class="flex flex-col gap-2">
					<span class="text-sm font-medium text-near-black">kossov-it</span>
					<div class="flex gap-2">
						<a href="/api/templates/kossov-it/export" download class="inline-flex items-center rounded-lg border border-border bg-bg-card px-3 py-1.5 text-xs font-medium text-near-black hover:bg-bg transition-colors">{t('action.export')}</a>
						<input bind:this={tmplFileInput} type="file" accept=".json" class="hidden" onchange={handleTemplateReplace} />
						<Btn variant="ghost" size="sm" loading={tmplReplacing} onclick={() => tmplFileInput?.click()}>{t('template.replace')}</Btn>
					</div>
				</div>
			</div>
		</Card>
	</section>
	{:else if activeSection === 'emails'}
	<section id="emails">
		<h2 class="text-xl font-semibold mb-4">{t('settings.emails')}</h2>
		<div class="space-y-6">
			<Card class="space-y-4">
				<h3 class="text-lg font-semibold">{t('section.smtpConfiguration')}</h3>
				<div class="grid grid-cols-1 gap-4 sm:grid-cols-2">
					<Input label={t('settings.smtpHost')} bind:value={smtpHost} placeholder={t('placeholder.smtpHost')} />
					<Input label={t('settings.smtpPort')} type="number" bind:value={smtpPort} />
					<Select label={t('settings.smtpSecure')} bind:value={smtpSecure}
						options={[{ value: 'false', label: t('settings.smtpSecureStarttls') }, { value: 'true', label: t('settings.smtpSecureSsl') }]} />
					<Input label={t('settings.smtpUser')} bind:value={smtpUser} />
					<Input label={t('settings.smtpPassword')} type="password" bind:value={smtpPass} placeholder={hasExistingPass ? '••••••••' : ''}
						oninput={() => { smtpPassChanged = true; }} />
					<Input label={t('settings.smtpFrom')} bind:value={smtpFrom} placeholder={t('placeholder.smtpFromEmail')} />
					<Input label={t('settings.smtpFromName')} bind:value={smtpFromName} placeholder={t('placeholder.smtpFromName')} />
				</div>
				<div class="flex gap-3 pt-2">
					<Btn loading={emailLoading} onclick={() => saveEmails()}>{t('action.save')}</Btn>
					<Btn variant="ghost" loading={emailTesting} onclick={testConnection}>{t('button.testConnection')}</Btn>
				</div>
			</Card>

			<Card class="space-y-4">
				<h3 class="text-lg font-semibold">{t('section.emailTemplates')}</h3>
				<p class="text-xs text-near-black/60">{t('help.emailPlaceholders')}</p>

				<h4 class="font-medium">{t('section.invoiceEmail')}</h4>
				<Input label={t('settings.subject')} bind:value={invSubject} />
				<TextArea label={t('settings.body')} bind:value={invBody} rows={3} />

				<h4 class="font-medium pt-2">{t('section.creditNoteEmail')}</h4>
				<Input label={t('settings.subject')} bind:value={cnSubject} />
				<TextArea label={t('settings.body')} bind:value={cnBody} rows={3} />

				<h4 class="font-medium pt-2">{t('section.proposalEmail')}</h4>
				<Input label={t('settings.subject')} bind:value={propSubject} />
				<TextArea label={t('settings.body')} bind:value={propBody} rows={3} />

				<h4 class="font-medium pt-2">{t('section.reminderEmail')}</h4>
				<Input label={t('settings.subject')} bind:value={remSubject} />
				<TextArea label={t('settings.body')} bind:value={remBody} rows={3} />

			</Card>
		</div>
	</section>
	{:else if activeSection === 'advanced'}
	<section id="advanced">
		<h2 class="text-xl font-semibold mb-4">{t('settings.advanced')}</h2>
		<Card class="space-y-4">
			<div class="flex items-center gap-3">
				<input type="checkbox" id="sepaQr" bind:checked={advSepaQrEnabled}
					class="h-4 w-4 rounded border-border text-cyan focus:ring-cyan" />
				<label for="sepaQr" class="text-sm font-medium">{t('help.enableSepaQr')}</label>
			</div>

			{#if advSepaQrEnabled}
				{#if data.settings.company.bankIban}
					<p class="text-xs text-near-black/60">{t('help.sepaIbanConfigured')}: <span class="font-mono">{data.settings.company.bankIban}</span></p>
				{:else}
					<p class="text-xs text-red-600">{t('help.sepaNoIban')}</p>
				{/if}
			{/if}

			<hr class="border-border" />

			<div class="space-y-2">
				<div class="flex items-center gap-3">
					<input type="checkbox" id="kleinunternehmer" bind:checked={advKleinunternehmer}
						class="h-4 w-4 rounded border-border text-cyan focus:ring-cyan" />
					<label for="kleinunternehmer" class="text-sm font-medium">{t('settings.kleinunternehmer')}</label>
				</div>
				<p class="text-xs text-near-black/60 ml-7">{t('help.kleinunternehmer')}</p>
			</div>

			<hr class="border-border" />

			<div class="space-y-2">
				<Select label={t('settings.editLock')} bind:value={advEditLock}
					options={[
						{ value: 'none', label: t('settings.editLockNoneDesc') },
						{ value: 'paid', label: t('settings.editLockPaidDesc') },
						{ value: 'sent', label: t('settings.editLockSentDesc') }
					]} />
				<p class="text-xs text-near-black/60">{t('help.editLock')}</p>
			</div>

		</Card>

		</section>

	{:else if activeSection === 'password'}
	<section id="password">
		<h2 class="text-xl font-semibold mb-4">{t('settings.changePassword')}</h2>
		<Card>
			<div class="grid gap-4 max-w-sm">
				<Input type="password" label={t('settings.currentPassword')} bind:value={pwCurrent} />
				<Input type="password" label={t('settings.newPassword')} bind:value={pwNew} />
				<Input type="password" label={t('settings.confirmPassword')} bind:value={pwConfirm} />
				{#if pwError}<p class="text-sm text-red">{pwError}</p>{/if}
				<Btn onclick={handleChangePassword} loading={pwLoading} disabled={!pwCurrent || !pwNew || !pwConfirm}>{t('settings.changePassword')}</Btn>
			</div>
		</Card>
	</section>

	{:else if activeSection === 'mfa'}
	<section id="mfa">
		<h2 class="text-xl font-semibold mb-4">{t('settings.mfa')}</h2>
		<MfaSection />
	</section>

	{:else if activeSection === 'backups'}
	<section id="backups">
		<h2 class="text-xl font-semibold mb-4">{t('settings.backups')}</h2>
		<div class="space-y-6">
			<BackupSection />

			<Card class="space-y-4">
				<div class="flex items-center justify-between">
					<div>
						<h3 class="text-lg font-semibold">{t('section.backups')}</h3>
						<p class="text-xs text-near-black/60 mt-1">{t('help.backupsDescription')}</p>
					</div>
					<Btn loading={bkpCreating} onclick={handleCreate}>{t('button.createBackup')}</Btn>
				</div>
			</Card>

			{#if backups.length === 0}
				<Card>
					<EmptyState title={t('empty.noBackups')} description={t('help.noBackupsYet')} />
				</Card>
			{:else}
				<div class="space-y-2">
					{#each backups as backup (backup.filename)}
						<Card padding={0}>
							<div class="flex items-center justify-between gap-4 p-4">
								<div class="min-w-0">
									<p class="text-sm font-medium truncate">{backup.filename}</p>
									<p class="text-xs text-near-black/60 mt-0.5">
										{formatDate(backup.createdAt)} &middot; {formatSize(backup.size)}
									</p>
								</div>
								<div class="flex items-center gap-2 shrink-0">
									<Btn variant="ghost" size="sm" loading={bkpRestoringFile === backup.filename || (bkpLoadingPreview && bkpPendingRestoreFile === backup.filename)} onclick={() => promptRestore(backup.filename)}>{t('button.restore')}</Btn>
									<Btn variant="ghost" size="sm" onclick={() => handleDownload(backup.filename)}>{t('action.download')}</Btn>
									<Btn
										variant="dangerSoft"
										size="sm"
										loading={bkpDeletingFile === backup.filename}
										onclick={() => promptDelete(backup.filename)}
									>{t('action.delete')}</Btn>
								</div>
							</div>
						</Card>
					{/each}
				</div>
			{/if}
		</div>
	</section>

	{:else if activeSection === 'remote-desktop'}
	<section id="remote-desktop">
		<h2 class="text-xl font-semibold mb-4">{t('rd.title')}</h2>
		<RemoteDesktopSection />
	</section>

	{:else if activeSection === 'alert-rules'}
	<section id="alert-rules">
		<h2 class="text-xl font-semibold mb-4">{t('alert.title')}</h2>
		<AlertRulesSection />
	</section>

	{:else if activeSection === 'custom-fields'}
	<section id="custom-fields">
		<h2 class="text-xl font-semibold mb-4">{t('customField.title')}</h2>
		<CustomFieldsSection />
	</section>

	{:else if activeSection === 'saved-filters'}
	<section id="saved-filters">
		<h2 class="text-xl font-semibold mb-4">{t('savedFilter.title')}</h2>
		<SavedFiltersSection />
	</section>

	{:else if activeSection === 'audit-integrity'}
	<section id="audit-integrity">
		<h2 class="text-xl font-semibold mb-4">{t('audit.title')}</h2>
		<AuditIntegritySection />
	</section>
	{/if}
	</div>
</div>

<!-- Dialogs -->
<ConfirmDialog
	open={showRemoveLogoConfirm}
	title={t('settings.removeLogo')}
	message={t('settings.removeLogoConfirm')}
	confirmLabel={t('button.remove')}
	variant="danger"
	onconfirm={() => { showRemoveLogoConfirm = false; removeLogo(); }}
	oncancel={() => { showRemoveLogoConfirm = false; }}
/>

<ConfirmDialog
	bind:open={bkpConfirmRestore}
	title={t('dialog.restoreTitle')}
	message={bkpRestorePreviewMessage || t('dialog.restoreBackupMessage')}
	confirmLabel={t('button.restore')}
	variant="danger"
	onconfirm={handleRestore}
	oncancel={() => (bkpConfirmRestore = false)}
/>

<ConfirmDialog
	bind:open={bkpConfirmDelete}
	title={t('dialog.deleteBackupTitle')}
	message={t('dialog.deleteBackupMessage')}
	confirmLabel={t('action.delete')}
	variant="danger"
	onconfirm={handleDelete}
	oncancel={() => (bkpConfirmDelete = false)}
/>

{#if tmplPreviewOpen}
	<!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
	<div
		class="fixed inset-0 z-50 flex items-center justify-center bg-black/60"
		role="dialog"
		aria-modal="true"
		aria-label={t('action.preview')}
		tabindex="-1"
		onclick={() => tmplPreviewOpen = false}
		onkeydown={(e) => { if (e.key === 'Escape') tmplPreviewOpen = false; }}
	>
		<!-- svelte-ignore a11y_no_static_element_interactions -->
		<!-- svelte-ignore a11y_click_events_have_key_events -->
		<div class="relative w-full max-w-3xl mx-4" onclick={(e) => e.stopPropagation()}>
			<button
				class="absolute -top-10 right-0 text-white/80 hover:text-white text-sm flex items-center gap-1"
				onclick={() => tmplPreviewOpen = false}
			>
				<svg class="h-5 w-5" fill="none" stroke="currentColor" viewBox="0 0 24 24" stroke-width="2"><path stroke-linecap="round" stroke-linejoin="round" d="M6 18L18 6M6 6l12 12" /></svg>
				{t('action.close')}
			</button>
			<iframe
				src="/api/templates/kossov-it/preview"
				class="w-full border-0 bg-white shadow-2xl rounded-lg"
				style="aspect-ratio: 210/297; max-height: 85vh;"
				title={t('action.preview')}
				sandbox="allow-same-origin"
			></iframe>
		</div>
	</div>
{/if}
