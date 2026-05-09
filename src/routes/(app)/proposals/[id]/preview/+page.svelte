<script lang="ts">
	import { page } from '$app/state';
	import Btn from '$lib/components/ui/Btn.svelte';
	import { ArrowRight } from '$lib/icons';
	import { t } from '$lib/i18n/index.svelte.js';

	const proposalId = $derived(page.params.id);
</script>

<div class="flex h-screen flex-col" style="background:var(--bg)">
	<div
		class="flex items-center justify-between border-b px-5 py-3"
		style="background:var(--card);border-color:var(--line)"
	>
		<a
			href="/proposals/{proposalId}"
			class="inline-flex items-center gap-1.5 text-[12.5px] font-medium underline hover:no-underline"
			style="color:var(--brand-ink)"
		>
			<span class="inline-flex" aria-hidden="true" style="transform:scaleX(-1)"><ArrowRight size={14} strokeWidth={1.6} /></span>
			{t('proposal.backToProposal')}
		</a>
		<Btn variant="ghost" size="sm" href="/api/proposals/{proposalId}/pdf" target="_blank" rel="noopener noreferrer">
			{t('action.downloadPdf')}
		</Btn>
	</div>
	<div class="flex flex-1 justify-center overflow-auto px-4 py-6">
		<iframe
			src="/api/proposals/{proposalId}/preview"
			class="w-full rounded border-0 bg-white shadow-pop"
			style="max-width: 210mm; aspect-ratio: 210/297;border-color:var(--line)"
			title={t('proposal.previewTitle')}
			sandbox="allow-same-origin"
		></iframe>
	</div>
</div>
