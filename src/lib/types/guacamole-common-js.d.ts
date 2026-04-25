// Minimal ambient types for guacamole-common-js (no upstream @types package).
// We type only the bits the popup page actually uses; if more API surface is
// needed later, extend this file rather than reaching for `any`.

declare module 'guacamole-common-js' {
	export class WebSocketTunnel {
		constructor(url: string);
	}

	export interface MouseState {
		x: number;
		y: number;
		left: boolean;
		middle: boolean;
		right: boolean;
		up: boolean;
		down: boolean;
	}

	export class Mouse {
		constructor(element: HTMLElement);
		onmousedown: ((s: MouseState) => void) | null;
		onmouseup: ((s: MouseState) => void) | null;
		onmousemove: ((s: MouseState) => void) | null;
	}

	export class Keyboard {
		constructor(element: HTMLElement | Document);
		onkeydown: ((keysym: number) => void) | null;
		onkeyup: ((keysym: number) => void) | null;
	}

	export interface Display {
		getElement(): HTMLElement;
		getWidth(): number;
		getHeight(): number;
	}

	export interface ClientStatus {
		code: number;
		message?: string;
	}

	export class Client {
		constructor(tunnel: WebSocketTunnel);
		connect(query?: string): void;
		disconnect(): void;
		getDisplay(): Display;
		sendKeyEvent(pressed: number, keysym: number): void;
		sendMouseState(state: MouseState): void;
		onstatechange: ((state: number) => void) | null;
		onerror: ((status: ClientStatus) => void) | null;
		onname: ((name: string) => void) | null;
	}

	const Guacamole: {
		WebSocketTunnel: typeof WebSocketTunnel;
		Client: typeof Client;
		Mouse: typeof Mouse;
		Keyboard: typeof Keyboard;
	};
	export default Guacamole;
}
