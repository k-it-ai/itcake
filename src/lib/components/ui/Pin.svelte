<script lang="ts">
	interface Props {
		n: number | string;
		background?: string;
		class?: string;
		title?: string;
	}

	let { n, background, class: className = '', title }: Props = $props();
</script>

<span
	class="inline-flex h-[18px] w-[18px] items-center justify-center rounded-full text-[10px] font-bold leading-none text-white num {className}"
	style={background ? `background:${background}` : 'background:var(--brand)'}
	{title}
	aria-label={title ?? `priority ${n}`}
>
	{n}
</span>
