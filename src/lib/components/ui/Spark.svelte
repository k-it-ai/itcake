<script lang="ts">
	interface Props {
		data: number[];
		color?: string;
		width?: number;
		height?: number;
		strokeWidth?: number;
		ariaLabel?: string;
		class?: string;
	}

	let {
		data,
		color = 'var(--brand)',
		width = 64,
		height = 20,
		strokeWidth = 1.5,
		ariaLabel,
		class: className = ''
	}: Props = $props();

	const padY = 2;
	const points = $derived.by(() => {
		if (!data || data.length === 0) return '';
		if (data.length === 1) {
			const cy = height / 2;
			return `0,${cy} ${width},${cy}`;
		}
		// Auto-max from data; no zero baseline (per 07-data-viz.md). Use the
		// observed range so a flat trend renders mid-band, not at the floor.
		const min = Math.min(...data);
		const max = Math.max(...data);
		const range = max - min || 1;
		const innerH = height - padY * 2;
		const stepX = width / (data.length - 1);
		return data
			.map((v, i) => {
				const x = i * stepX;
				const y = padY + innerH - ((v - min) / range) * innerH;
				return `${x.toFixed(2)},${y.toFixed(2)}`;
			})
			.join(' ');
	});
</script>

<svg
	{width}
	{height}
	viewBox="0 0 {width} {height}"
	class={className}
	role={ariaLabel ? 'img' : undefined}
	aria-label={ariaLabel}
	aria-hidden={ariaLabel ? undefined : 'true'}
	preserveAspectRatio="none"
>
	{#if points}
		<polyline
			fill="none"
			stroke={color}
			stroke-width={strokeWidth}
			stroke-linecap="round"
			stroke-linejoin="round"
			{points}
		/>
	{/if}
</svg>
