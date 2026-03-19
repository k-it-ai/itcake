<script lang="ts">
	import { t } from '$lib/i18n/index.svelte.js';

	interface TemplateOption {
		id: string;
		name: string;
	}

	interface Props {
		templates: TemplateOption[];
		value: string;
		label?: string;
		onchange?: (id: string) => void;
	}

	let { templates, value = $bindable(), label, onchange }: Props = $props();

	function select(id: string) {
		value = id;
		onchange?.(id);
	}
</script>

{#if label}
	<p class="text-sm font-medium text-near-black mb-2">{label}</p>
{/if}
<div class="flex gap-3 overflow-x-auto pb-2 -mb-2 snap-x snap-mandatory" role="radiogroup" aria-label={label || t('settings.defaultTemplate')}>
	{#each templates as tmpl}
		<button
			type="button"
			class="snap-start flex-shrink-0 w-28 rounded-lg border-2 transition-all cursor-pointer group
				{value === tmpl.id
					? 'border-cyan ring-1 ring-cyan/30 bg-cyan/5 dark:bg-cyan/10'
					: 'border-border hover:border-near-black/30 dark:hover:border-white/30 bg-bg-card'}"
			onclick={() => select(tmpl.id)}
			role="radio"
			aria-checked={value === tmpl.id}
		>
			<div class="aspect-[210/297] w-full overflow-hidden rounded-t-md bg-white">
				<img
					src="/api/templates/{tmpl.id}/thumbnail"
					alt={tmpl.name}
					class="w-full h-full object-cover object-top"
					loading="lazy"
				/>
			</div>
			<div class="px-2 py-1.5 text-center">
				<span class="text-xs font-medium text-near-black truncate block {value === tmpl.id ? 'text-cyan' : ''}">{tmpl.name}</span>
			</div>
		</button>
	{/each}
</div>
