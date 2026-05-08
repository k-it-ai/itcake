<script lang="ts">
	interface Props {
		width?: string | number;
		height?: string | number;
		rounded?: 'sm' | 'md' | 'full' | 'none';
		class?: string;
		ariaLabel?: string;
	}

	let {
		width = '60%',
		height = 12,
		rounded = 'sm',
		class: className = '',
		ariaLabel = 'Loading'
	}: Props = $props();

	const roundedClass = $derived(
		({ sm: 'rounded-[4px]', md: 'rounded-md', full: 'rounded-full', none: '' })[rounded]
	);

	const widthCss = $derived(typeof width === 'number' ? `${width}px` : width);
	const heightCss = $derived(typeof height === 'number' ? `${height}px` : height);
</script>

<span
	class="block skeleton {roundedClass} {className}"
	style="width:{widthCss};height:{heightCss}"
	role="status"
	aria-busy="true"
	aria-live="polite"
	aria-label={ariaLabel}
></span>
