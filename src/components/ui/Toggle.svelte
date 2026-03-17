<script lang="ts">
	interface Props {
		checked: boolean;
		label?: string;
		id?: string;
		onchange?: (e: Event) => void;
	}

	let { checked = $bindable(false), label = '', id, onchange }: Props = $props();
</script>

<label class="relative inline-flex cursor-pointer items-center gap-2">
	<input type="checkbox" role="switch" {id} bind:checked {onchange} aria-label={label || undefined} class="peer sr-only" />
	<div class="h-5 w-9 rounded-full bg-border after:absolute after:left-[2px] after:top-[2px] after:h-4 after:w-4 after:rounded-full after:bg-white after:transition-all peer-checked:bg-cyan peer-checked:after:translate-x-full peer-focus-visible:ring-2 peer-focus-visible:ring-cyan peer-focus-visible:ring-offset-2 shrink-0"></div>
	{#if label}
		<span class="text-sm text-near-black">{label}</span>
	{/if}
</label>
