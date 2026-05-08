<script lang="ts">
	type Tone = 'good' | 'brand' | 'warn' | 'bad' | 'mute';

	interface Props {
		tone?: Tone;
		class?: string;
		title?: string;
	}

	let { tone = 'mute', class: className = '', title }: Props = $props();

	// Per 03-primitives.md: dot-only saturated scale, distinct from soft-fill text colours.
	const toneHex: Record<Tone, string> = {
		good: '#1f8a5b',
		brand: '#0e7c9c',
		warn: '#a85a00',
		bad: '#a8232c',
		mute: '#9aa3ad'
	};
</script>

<span
	class="inline-block h-2 w-2 rounded-full {className}"
	style="background:{toneHex[tone]}"
	role="presentation"
	aria-hidden={title ? undefined : 'true'}
	aria-label={title}
></span>
