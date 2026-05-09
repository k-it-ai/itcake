<script lang="ts">
	type Tone = 'brand' | 'good' | 'warn' | 'bad' | 'accent' | 'ink';

	interface Props {
		n: number | string;
		tone?: Tone;
		class?: string;
		title?: string;
	}

	let { n, tone = 'brand', class: className = '', title }: Props = $props();

	// Closed enum → CSS token. Prevents callers passing raw CSS into the
	// style attribute, which would be a CSS-injection / clickjack overlay
	// vector if the prop were ever fed user-controlled data.
	const toneStyle: Record<Tone, string> = {
		brand: 'background:var(--brand);color:#ffffff',
		good: 'background:var(--good);color:#ffffff',
		warn: 'background:var(--warn);color:#ffffff',
		bad: 'background:var(--bad);color:#ffffff',
		accent: 'background:var(--accent);color:#ffffff',
		ink: 'background:var(--ink);color:#ffffff'
	};
</script>

<span
	class="inline-flex h-[18px] w-[18px] items-center justify-center rounded-full text-[10px] font-bold leading-none num {className}"
	style={toneStyle[tone]}
	{title}
	aria-label={title ?? `priority ${n}`}
>
	{n}
</span>
