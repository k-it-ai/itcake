<script lang="ts">
	import Badge from '$components/ui/Badge.svelte';
	import { invoiceBadgeVariant } from '$lib/select-options.js';
	import { t } from '$lib/i18n/index.svelte.js';
	import type { InvoiceStatus } from '$lib/types.js';

	interface Props {
		status: InvoiceStatus;
	}

	let { status }: Props = $props();

	// Non-color indicator per status for WCAG 1.4.1 (Use of Color)
	const statusIcon: Record<InvoiceStatus, string> = {
		draft: '✎',
		sent: '↗',
		paid: '✓',
		overdue: '!',
		cancelled: '✕'
	};
</script>

<Badge variant={invoiceBadgeVariant(status)}><span aria-hidden="true">{statusIcon[status]}</span> {t('status.' + status)}</Badge>
