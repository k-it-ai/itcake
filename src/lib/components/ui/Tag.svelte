<script lang="ts">
	import type { Snippet } from 'svelte';

	type Tone = 'neutral' | 'brand' | 'good' | 'warn' | 'bad' | 'accent' | 'ink';

	interface Props {
		tone?: Tone;
		class?: string;
		title?: string;
		children: Snippet;
	}

	let { tone = 'neutral', class: className = '', title, children }: Props = $props();

	const toneStyle: Record<Tone, string> = {
		neutral: 'background:#eef0f4;color:#3a424c',
		brand: 'background:var(--brand-soft);color:var(--brand-ink)',
		good: 'background:var(--good-soft);color:#0f5d3d',
		warn: 'background:var(--warn-soft);color:#7a4400',
		bad: 'background:var(--bad-soft);color:#7a1a22',
		accent: 'background:var(--accent-soft);color:#7a4a00',
		ink: 'background:var(--ink);color:#ffffff'
	};
</script>

<span
	class="inline-flex items-center rounded-full px-2 py-[2px] text-[11px] font-medium num {className}"
	style={toneStyle[tone]}
	{title}
>
	{@render children()}
</span>
