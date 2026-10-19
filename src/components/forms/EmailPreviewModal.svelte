<script lang="ts">
	import Modal from '#components/ui/Modal.svelte';
	import Button from '#components/ui/Button.svelte';
	import Input from '#components/ui/Input.svelte';
	import TextArea from '#components/ui/TextArea.svelte';
	import { toast } from '#components/ui/Toast.svelte';
	import { t } from '#lib/i18n/index.svelte.js';

	interface Props {
		open: boolean;
		to: string;
		subject: string;
		body: string;
		attachmentId: string;
		attachmentType: 'invoice' | 'proposal';
		documentType?: string;
		fromEmail?: string;
		onclose: () => void;
		onsent?: () => void;
	}

	let { open = $bindable(false), to, subject, body, attachmentId, attachmentType, documentType = 'Invoice', fromEmail = '', onclose, onsent }: Props = $props();

	let editTo = $state(to);
	let editCc = $state('');
	let editBcc = $state('');
	let editSubject = $state(subject);
	let editBody = $state(body);
	let sending = $state(false);
	let sendError = $state('');
	let toError = $state('');
	let subjectError = $state('');

	$effect(() => {
		if (open) {
			editTo = to;
			editCc = '';
			editBcc = '';
			editSubject = subject;
			editBody = body;
			sendError = '';
			toError = '';
			subjectError = '';
		}
	});

	async function handleSend() {
		toError = !editTo.trim() ? t('email.recipientRequired')
			: !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(editTo.trim()) ? t('email.invalidEmail')
			: '';
		subjectError = editSubject.trim() ? '' : t('email.subjectRequired');
		if (toError || subjectError) return;
		sending = true;
		sendError = '';
		try {
			const res = await fetch('/api/emails', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({
					to: editTo,
					cc: editCc || undefined,
					bcc: editBcc || undefined,
					subject: editSubject,
					body: editBody,
					attachmentId,
					attachmentType
				})
			});
			const data = await res.json();
			if (data.ok) {
				toast(t('toast.emailSent'));
				open = false;
				onsent?.();
			} else {
				sendError = data.error || t('toast.emailFailed');
				toast(t('toast.emailFailed'), 'error');
			}
		} catch {
			sendError = t('toast.emailFailed');
			toast(t('toast.emailFailed'), 'error');
		} finally {
			sending = false;
		}
	}
</script>

<Modal {open} title={t('email.sendDocument', { type: documentType })} {onclose}>
	{#snippet children()}
		<div class="space-y-4">
			{#if fromEmail}
				<div>
					<span class="text-xs font-medium text-ink/60">{t('email.from')}</span>
					<p class="text-sm text-ink/80">{fromEmail}</p>
				</div>
			{/if}
			<Input label={t('email.to')} bind:value={editTo} type="email" required error={toError} />
			<Input label={t('email.cc')} bind:value={editCc} placeholder={t('email.commaSeparated')} />
			<Input label={t('email.bcc')} bind:value={editBcc} placeholder={t('email.commaSeparated')} />
			<Input label={t('email.subject')} bind:value={editSubject} required error={subjectError} />
			<TextArea label={t('email.body')} bind:value={editBody} rows={6} />
			<p class="text-xs text-ink/60">{t('email.attachPdf')}</p>
			{#if sendError}
				<p class="text-sm text-bad dark:text-bad-300" role="alert">{sendError}</p>
			{/if}
		</div>
	{/snippet}
	{#snippet actions()}
		<Button variant="secondary" onclick={onclose}>{t('action.cancel')}</Button>
		<Button loading={sending} onclick={handleSend}>{t('email.send')}</Button>
	{/snippet}
</Modal>
