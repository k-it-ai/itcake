<script lang="ts">
	type AvatarSize = 20 | 22 | 24 | 28;

	interface Props {
		name: string;
		src?: string;
		size?: AvatarSize;
		alt?: string;
		class?: string;
	}

	let { name, src, size = 24, alt, class: className = '' }: Props = $props();

	function initials(input: string): string {
		const tokens = input.trim().split(/\s+/).filter(Boolean);
		if (tokens.length === 0) return '?';
		const first = tokens[0]?.[0] ?? '';
		const second = tokens[1]?.[0] ?? '';
		const pair = `${first}${second}`;
		// Per spec: never single character — duplicate the first if only one token.
		const out = pair.length >= 2 ? pair : (first + first);
		return out.toUpperCase();
	}

	const display = $derived(initials(name));
	const fontPx = $derived(Math.max(9, Math.round(size * 0.45)));
</script>

{#if src}
	<img
		{src}
		alt={alt ?? name}
		width={size}
		height={size}
		class="inline-block rounded-[4px] object-cover {className}"
		style="width:{size}px;height:{size}px"
	/>
{:else}
	<span
		class="inline-flex items-center justify-center rounded-[4px] font-semibold {className}"
		style="width:{size}px;height:{size}px;background:#eef0f4;color:#3a424c;font-size:{fontPx}px;line-height:1"
		aria-label={alt ?? name}
		role="img"
	>
		{display}
	</span>
{/if}
