/**
 * Basic production load test.
 *
 * Boots the real production artifact behind the same trusted-proxy shape used
 * by install.sh (`HOST=127.0.0.1`, `ADDRESS_HEADER=X-Forwarded-For`), seeds a
 * small dataset through the public API, then drives a sustained read load from
 * several concurrent clients while checking that:
 *   - every response is 200 (no 5xx, no dropped connections)
 *   - health checks stay responsive under load
 *   - latency stays within a generous ceiling (this catches stalls, not
 *     micro-benchmark regressions)
 *   - concurrent writes serialize correctly and produce unique ids
 *   - the per-IP API limiter trips at its documented 600/minute boundary and
 *     health checks remain exempt
 *
 * Thresholds are deliberately loose: the point is to prove the single-process
 * server does not block, deadlock, or corrupt state, not to benchmark a
 * specific host.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import crypto from 'node:crypto';
import {
	startProductionServer, freshDataDir, cleanupDir, jsonCall, setupAdmin, sleep,
	type LiveServer
} from './helpers';

const PORT = 5505;
const DATA_DIR = freshDataDir('load');
const ADMIN_EMAIL = 'load-live@example.com';
const SEED_CLIENTS = 30;
const SEED_INVOICES = 30;
const WRITE_CLIENTS = 20;
const API_LIMIT_PER_MINUTE = 600;
// All requests must carry X-Forwarded-For because the server is started with
// ADDRESS_HEADER. This is the simulated operator IP for setup and seeding.
const XFF_ADMIN = '203.0.113.1';

let server: LiveServer;
let cookie = '';

interface LatencySample {
	route: string;
	status: number;
	ms: number;
}

function clientPayload(index: number): Record<string, unknown> {
	return {
		name: `Load Client ${index}`,
		email: `load-client-${index}@example.com`,
		address: {
			street: `${index} Load Street`,
			city: 'Load City',
			zip: '10115',
			state: '',
			country: 'DE'
		},
		currency: 'EUR',
		language: 'en',
		paymentTermDays: 30
	};
}

function invoicePayload(clientId: string, index: number): Record<string, unknown> {
	const today = new Date();
	const due = new Date(today.getTime() + 14 * 86_400_000);
	const iso = (d: Date) => d.toISOString().slice(0, 10);
	return {
		clientId,
		currency: 'EUR',
		language: 'en',
		issueDate: iso(today),
		dueDate: iso(due),
		items: [
			{
				id: crypto.randomUUID(),
				name: `Load service ${index}`,
				description: 'Load-test line item',
				quantity: 1,
				unit: 'h',
				unitPrice: 10_000,
				taxRate: 19,
				items: []
			}
		]
	};
}

beforeAll(async () => {
	server = await startProductionServer({
		port: PORT,
		dataDir: DATA_DIR,
		env: {
			// The test process is the trusted loopback proxy. Simulating distinct
			// X-Forwarded-For clients keeps the per-IP limiter out of the load
			// phase; the limiter itself is exercised separately below.
			ADDRESS_HEADER: 'X-Forwarded-For'
		}
	});
	cookie = await setupAdmin(server, ADMIN_EMAIL, {}, { xff: XFF_ADMIN });

	for (let i = 0; i < SEED_CLIENTS; i++) {
		const created = await jsonCall(server, 'POST', '/api/clients', clientPayload(i), { cookie, xff: XFF_ADMIN });
		expect(created.status, `seed client ${i}: ${JSON.stringify(created.data)}`).toBe(201);
	}

	const clients = await jsonCall(server, 'GET', '/api/clients', undefined, { cookie, xff: XFF_ADMIN });
	expect(clients.status, JSON.stringify(clients.data)).toBe(200);
	const clientList = clients.data as unknown as Array<{ id: string; name: string }>;
	expect(clientList).toHaveLength(SEED_CLIENTS);

	for (let i = 0; i < SEED_INVOICES; i++) {
		const client = clientList[i % clientList.length];
		const created = await jsonCall(
			server,
			'POST',
			'/api/invoices',
			invoicePayload(client.id, i),
			{ cookie, xff: XFF_ADMIN }
		);
		expect(created.status, `seed invoice ${i}: ${JSON.stringify(created.data)}`).toBe(201);
	}
}, 180_000);

afterAll(async () => {
	await server?.stop();
	cleanupDir(DATA_DIR);
});

describe('production load', () => {
	it('serves sustained concurrent reads without errors or stalls', async () => {
		const routes = [
			'/api/clients',
			'/api/invoices',
			'/api/invoices?status=draft',
			'/api/proposals',
			'/api/tasks',
			'/api/search?q=Load'
		];
		const workers = 10;
		const durationMs = 2_500;
		const samples: LatencySample[] = [];
		const errors: string[] = [];
		const deadline = Date.now() + durationMs;

		async function worker(workerId: number): Promise<void> {
			let iteration = 0;
			while (Date.now() < deadline) {
				// Include health on every fifth request so a stalled event loop
				// shows up as a health failure, not just slow list reads.
				const health = iteration % 5 === 4;
				const route = health
					? '/api/healthz'
					: routes[(workerId + iteration) % routes.length];
				// Rotate through a small pool of simulated client IPs per worker so
				// no single per-IP bucket reaches its 600/minute ceiling.
				const xff = `198.51.100.${workerId * 5 + (iteration % 5) + 1}`;
				const started = performance.now();
				try {
					const res = await jsonCall(server, 'GET', route, undefined, {
						cookie: health ? undefined : cookie,
						xff
					});
					const ms = performance.now() - started;
					samples.push({ route, status: res.status, ms });
					if (res.status !== 200) {
						errors.push(`${route} -> ${res.status} ${JSON.stringify(res.data)}`);
					}
				} catch (err) {
					errors.push(`${route} -> ${err instanceof Error ? err.message : String(err)}`);
				}
				iteration += 1;
			}
		}

		await Promise.all(Array.from({ length: workers }, (_, i) => worker(i)));

		expect(errors, `${errors.length} request(s) failed:\n${errors.slice(0, 10).join('\n')}`).toHaveLength(0);
		expect(samples.length, 'load loop produced too few requests').toBeGreaterThan(100);

		const sorted = samples.map((s) => s.ms).sort((a, b) => a - b);
		const percentile = (p: number) => sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))];
		const p50 = percentile(0.5);
		const p95 = percentile(0.95);
		const max = sorted[sorted.length - 1];
		console.log(
			`[load] ${samples.length} requests, ${workers} workers, ` +
			`p50=${p50.toFixed(1)}ms p95=${p95.toFixed(1)}ms max=${max.toFixed(1)}ms`
		);

		// Generous ceilings: this fails on a stall or a serialized multi-second
		// lock, not on a slow CI runner.
		expect(p95, `p95 ${p95.toFixed(1)}ms exceeded 2500ms`).toBeLessThan(2_500);
		expect(max, `max ${max.toFixed(1)}ms exceeded 8000ms`).toBeLessThan(8_000);

		// The server must still be healthy after the burst.
		const health = await jsonCall(server, 'GET', '/api/healthz');
		expect(health.status).toBe(200);
		expect(health.data.status).toBe('ok');
	}, 120_000);

	it('enforces the per-IP API limit and keeps health exempt', async () => {
		// Dedicated IP so the earlier load phase does not consume this bucket.
		const xff = '203.0.113.250';

		for (let i = 0; i < API_LIMIT_PER_MINUTE; i++) {
			const res = await jsonCall(server, 'GET', '/api/clients', undefined, { cookie, xff });
			expect(res.status, `request ${i + 1} unexpectedly limited: ${JSON.stringify(res.data)}`).toBe(200);
		}

		const limited = await jsonCall(server, 'GET', '/api/clients', undefined, { cookie, xff });
		expect(limited.status).toBe(429);
		expect(limited.data.error).toBe('rate_limited');
		expect(Number(limited.data.retryAfter)).toBeGreaterThan(0);
		expect(Number(limited.res.headers.get('retry-after'))).toBeGreaterThan(0);

		// A different client IP is unaffected.
		const other = await jsonCall(server, 'GET', '/api/clients', undefined, {
			cookie,
			xff: '203.0.113.251'
		});
		expect(other.status).toBe(200);

		// Health checks are explicitly exempt, even from the blocked IP.
		const health = await jsonCall(server, 'GET', '/api/healthz', undefined, { xff });
		expect(health.status).toBe(200);
	}, 180_000);

	it('serializes concurrent writes and keeps ids unique', async () => {
		const created = await Promise.all(
			Array.from({ length: WRITE_CLIENTS }, (_, i) =>
				jsonCall(server, 'POST', '/api/clients', clientPayload(1_000 + i), {
					cookie,
					xff: `198.18.${Math.floor(i / 250)}.${(i % 250) + 1}`
				})
			)
		);

		for (const [i, res] of created.entries()) {
			expect(res.status, `concurrent create ${i}: ${JSON.stringify(res.data)}`).toBe(201);
		}
		const ids = created.map((res) => String(res.data.id));
		expect(new Set(ids).size).toBe(WRITE_CLIENTS);

		const list = await jsonCall(server, 'GET', '/api/clients', undefined, { cookie, xff: XFF_ADMIN });
		expect(list.status).toBe(200);
		const clientList = list.data as unknown as Array<{ id: string }>;
		expect(clientList).toHaveLength(SEED_CLIENTS + WRITE_CLIENTS);
		for (const id of ids) {
			expect(clientList.some((c) => c.id === id), `created client ${id} missing after reload`).toBe(true);
		}

		// Let the event loop settle, then confirm the process is still serving.
		await sleep(100);
		const health = await jsonCall(server, 'GET', '/api/healthz');
		expect(health.status).toBe(200);
	}, 120_000);
});
