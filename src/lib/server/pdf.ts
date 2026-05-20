import puppeteer from 'puppeteer';
import type { Browser } from 'puppeteer';
import { env } from '$env/dynamic/private';
import { ServiceError } from '$lib/server/service-error.js';
import { registerShutdownTask } from '$lib/server/shutdown.js';

class AsyncMutex {
	#queue: Array<() => void> = [];
	#locked = false;

	async acquire(): Promise<void> {
		if (!this.#locked) {
			this.#locked = true;
			return;
		}
		return new Promise<void>((resolve) => this.#queue.push(resolve));
	}

	release(): void {
		const next = this.#queue.shift();
		if (next) next();
		else this.#locked = false;
	}
}

class Semaphore {
	#available: number;
	#maxQueueDepth: number;
	#queue: Array<{ resolve: () => void; reject: (err: Error) => void }> = [];

	constructor(permits: number, maxQueueDepth = 10) {
		this.#available = permits;
		this.#maxQueueDepth = maxQueueDepth;
	}

	async acquire(timeoutMs = 60_000): Promise<void> {
		if (this.#available > 0) {
			this.#available--;
			return;
		}
		if (this.#queue.length >= this.#maxQueueDepth) {
			throw new ServiceError('error.tooManyPdfRequests');
		}
		return new Promise<void>((resolve, reject) => {
			const entry = { resolve, reject };
			this.#queue.push(entry);
			const timer = setTimeout(() => {
				const idx = this.#queue.indexOf(entry);
				if (idx !== -1) {
					this.#queue.splice(idx, 1);
					reject(new Error('PDF generation timed out waiting for available page'));
				}
			}, timeoutMs);
			const origResolve = resolve;
			entry.resolve = () => { clearTimeout(timer); origResolve(); };
		});
	}

	release(): void {
		const next = this.#queue.shift();
		if (next) next.resolve();
		else this.#available++;
	}
}

const browserMutex = new AsyncMutex();
const pageSemaphore = new Semaphore(4); // max 4 concurrent Puppeteer pages
let browserPromise: Promise<Browser> | null = null;
let lastLaunchFailure = 0;
const LAUNCH_COOLDOWN_MS = 10_000;

async function getBrowser(): Promise<Browser> {
	if (Date.now() - lastLaunchFailure < LAUNCH_COOLDOWN_MS) {
		throw new ServiceError('error.pdfGenerationUnavailable');
	}
	await browserMutex.acquire();
	try {
		if (browserPromise) {
			try {
				const b = await browserPromise;
				if (b.connected) return b;
			} catch (e) {
				console.warn('Puppeteer browser reconnection failed, re-launching:', e instanceof Error ? e.message : e);
			}
			browserPromise = null;
		}

		const noSandbox = env.PUPPETEER_NO_SANDBOX === 'true';
		if (noSandbox) {
			console.warn('[pdf] WARNING: Running Chromium with --no-sandbox. This reduces isolation between the renderer and host. Only use in containerized environments.');
		}
		browserPromise = puppeteer.launch({
			headless: true,
			args: [
				...(noSandbox ? ['--no-sandbox', '--disable-setuid-sandbox'] : []),
				'--disable-dev-shm-usage'
			]
		});

		try {
			return await browserPromise;
		} catch (e) {
			browserPromise = null;
			lastLaunchFailure = Date.now();
			throw e;
		}
	} finally {
		browserMutex.release();
	}
}

async function withPage<T>(fn: (page: Awaited<ReturnType<Browser['newPage']>>) => Promise<T>): Promise<T> {
	await pageSemaphore.acquire();
	try {
		const b = await getBrowser();
		const page = await b.newPage();
		try {
			await page.setJavaScriptEnabled(false);
			await page.setRequestInterception(true);
			page.on('request', (req) => {
				if (req.url().startsWith('data:')) req.continue();
				else req.abort('blockedbyclient');
			});
			return await fn(page);
		} finally {
			await page.close();
		}
	} finally {
		pageSemaphore.release();
	}
}

export async function generatePdf(html: string): Promise<Buffer> {
	return withPage(async (page) => {
		await page.setContent(html, { waitUntil: 'domcontentloaded', timeout: 30_000 });
		const pdf = await page.pdf({
			format: 'A4',
			margin: { top: '0', right: '0', bottom: '0', left: '0' },
			printBackground: true,
			preferCSSPageSize: true
		});
		return Buffer.from(pdf);
	});
}

export async function generateThumbnail(html: string, width = 420): Promise<Buffer> {
	return withPage(async (page) => {
		const height = Math.round(width * (297 / 210)); // A4 proportions
		await page.setViewport({ width, height, deviceScaleFactor: 2 });
		await page.setContent(html, { waitUntil: 'domcontentloaded', timeout: 30_000 });
		const screenshot = await page.screenshot({
			type: 'png',
			clip: { x: 0, y: 0, width, height }
		});
		return Buffer.from(screenshot);
	});
}

getBrowser().catch((e) => console.error('Puppeteer initial launch failed:', e instanceof Error ? e.message : e));

registerShutdownTask('puppeteer-browser-close', async () => {
	if (browserPromise) {
		const p = browserPromise;
		browserPromise = null;
		try { (await p).close(); } catch { /* best effort */ }
	}
});
