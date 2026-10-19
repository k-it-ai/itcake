import { browser } from '$app/env';

type Theme = 'light' | 'dark';

function getInitialTheme(): Theme {
	if (!browser) return 'light';
	const stored = localStorage.getItem('itcake-theme');
	if (stored === 'dark' || stored === 'light') return stored;
	return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

let current = $state<Theme>(getInitialTheme());

export const theme = {
	get value() { return current; },
	set value(v: Theme) { current = v; },
	toggle() { current = current === 'light' ? 'dark' : 'light'; }
};

if (browser) {
	$effect.root(() => {
		$effect(() => {
			document.documentElement.setAttribute('data-theme', current);
			localStorage.setItem('itcake-theme', current);
		});
	});
}
