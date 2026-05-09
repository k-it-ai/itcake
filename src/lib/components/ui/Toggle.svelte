<script lang="ts">
	interface Props {
		checked: boolean;
		disabled?: boolean;
		ariaLabel?: string;
		label?: string;
		id?: string;
		class?: string;
		onchange?: (checked: boolean) => void;
	}

	let {
		checked = $bindable(false),
		disabled = false,
		ariaLabel,
		label,
		id,
		class: className = '',
		onchange
	}: Props = $props();

	function toggle() {
		if (disabled) return;
		checked = !checked;
		onchange?.(checked);
	}

	function onKey(e: KeyboardEvent) {
		if (disabled) return;
		if (e.key === ' ' || e.key === 'Enter') {
			e.preventDefault();
			toggle();
		}
	}
</script>

<span class="inline-flex items-center">
	<button
		type="button"
		{id}
		role="switch"
		aria-checked={checked}
		aria-label={ariaLabel ?? label}
		{disabled}
		onclick={toggle}
		onkeydown={onKey}
		class="relative inline-flex shrink-0 items-center rounded-full transition-colors focus-visible:outline-2 focus-visible:outline-[var(--brand)] focus-visible:outline-offset-2 disabled:opacity-50 disabled:cursor-not-allowed {className}"
		style="width:30px;height:16px;background:{checked ? 'var(--brand)' : '#cfd6dd'}"
	>
		<span
			class="block rounded-full bg-white"
			style="width:12px;height:12px;transform:translateX({checked ? 16 : 2}px);transition:transform 150ms ease"
		></span>
	</button>
	{#if label}
		<label for={id} class="ml-2 text-[12px]" style="color:var(--ink)">{label}</label>
	{/if}
</span>
