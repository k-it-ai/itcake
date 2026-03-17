<script lang="ts">
	import Modal from './Modal.svelte';
	import Button from './Button.svelte';
	import { t } from '$lib/i18n/index.svelte.js';

	interface Props {
		open: boolean;
		title?: string;
		message: string;
		confirmLabel?: string;
		cancelLabel?: string;
		variant?: 'danger' | 'primary';
		onconfirm: () => void;
		oncancel: () => void;
	}

	let {
		open = $bindable(false),
		title = t('action.confirm'),
		message,
		confirmLabel = t('action.confirm'),
		cancelLabel = t('action.cancel'),
		variant = 'danger',
		onconfirm,
		oncancel
	}: Props = $props();
</script>

<Modal {open} {title} onclose={oncancel}>
	{#snippet children()}
		<p class="text-sm text-near-black/70">{message}</p>
	{/snippet}
	{#snippet actions()}
		<Button variant="secondary" onclick={oncancel}>{cancelLabel}</Button>
		<Button variant={variant === 'danger' ? 'danger' : 'primary'} onclick={onconfirm}>{confirmLabel}</Button>
	{/snippet}
</Modal>
