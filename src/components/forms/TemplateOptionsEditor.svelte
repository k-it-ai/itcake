<script lang="ts">
	import Toggle from '$components/ui/Toggle.svelte';
	import { t } from '$lib/i18n/index.svelte.js';
	import type { TemplateOption } from '$lib/types.js';

	interface Props {
		options: TemplateOption[];
		values: Record<string, unknown>;
	}

	let { options, values = $bindable({}) }: Props = $props();

	let FONT_CHOICES = $derived([
		{ value: '', label: t('misc.default') },
		{ value: 'Georgia, serif', label: 'Georgia' },
		{ value: "'Times New Roman', Times, serif", label: 'Times New Roman' },
		{ value: 'Arial, Helvetica, sans-serif', label: 'Arial' },
		{ value: "'Helvetica Neue', Helvetica, sans-serif", label: 'Helvetica Neue' },
		{ value: 'Verdana, Geneva, sans-serif', label: 'Verdana' },
		{ value: "'Trebuchet MS', sans-serif", label: 'Trebuchet MS' },
		{ value: "'Courier New', Courier, monospace", label: 'Courier New' },
		{ value: "'Lucida Console', Monaco, monospace", label: 'Lucida Console' },
		{ value: "'Palatino Linotype', 'Book Antiqua', Palatino, serif", label: 'Palatino' },
		{ value: "'Gill Sans', 'Gill Sans MT', sans-serif", label: 'Gill Sans' },
		{ value: "Garamond, 'Times New Roman', serif", label: 'Garamond' },
		{ value: "'Segoe UI', Tahoma, Geneva, sans-serif", label: 'Segoe UI' },
	]);

	function getValue(opt: TemplateOption): unknown {
		return values[opt.key] ?? opt.default;
	}

	function setValue(key: string, value: unknown) {
		values = { ...values, [key]: value };
	}
</script>

{#if options.length > 0}
	<div class="grid grid-cols-1 gap-3 sm:grid-cols-2">
		{#each options as opt}
			<div>
				<label for="topt-{opt.key}" class="mb-1 block text-sm font-medium text-near-black">{opt.label}</label>
				{#if opt.type === 'color'}
					<div class="flex items-center gap-2">
						<input
							id="topt-{opt.key}"
							type="color"
							value={String(getValue(opt))}
							oninput={(e) => setValue(opt.key, e.currentTarget.value)}
							class="h-9 w-12 cursor-pointer rounded border border-border"
						/>
						<span class="text-xs text-near-black/60 tabular-nums">{String(getValue(opt))}</span>
					</div>
				{:else if opt.type === 'font'}
					<select
						id="topt-{opt.key}"
						value={String(getValue(opt))}
						onchange={(e) => setValue(opt.key, e.currentTarget.value)}
						class="w-full rounded border border-border bg-input-bg text-near-black px-3 py-2 text-sm focus:border-cyan focus:outline-none"
						style="font-family: {String(getValue(opt)) || 'inherit'}"
					>
						{#each FONT_CHOICES as font}
							<option value={font.value} style="font-family: {font.value || 'inherit'}">{font.label}</option>
						{/each}
					</select>
				{:else if opt.type === 'select'}
					<select
						id="topt-{opt.key}"
						value={String(getValue(opt))}
						onchange={(e) => setValue(opt.key, e.currentTarget.value)}
						class="w-full rounded border border-border bg-input-bg text-near-black px-3 py-2 text-sm focus:border-cyan focus:outline-none"
					>
						{#each opt.options ?? [] as o}
							<option value={o.value}>{o.label}</option>
						{/each}
					</select>
				{:else if opt.type === 'boolean'}
					<Toggle label={opt.label} checked={Boolean(getValue(opt))} onchange={(e) => setValue(opt.key, (e.currentTarget as HTMLInputElement).checked)} />
				{:else}
					<input
						id="topt-{opt.key}"
						type="text"
						value={String(getValue(opt))}
						oninput={(e) => setValue(opt.key, e.currentTarget.value)}
						class="w-full rounded border border-border bg-input-bg text-near-black px-3 py-2 text-sm focus:border-cyan focus:outline-none"
					/>
				{/if}
			</div>
		{/each}
	</div>
{/if}
