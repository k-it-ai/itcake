import { describe, it, expect } from 'vitest';
import { dispatchCommandSchema } from '../../src/lib/validators-rmm.js';

describe('dispatchCommandSchema reboot type', () => {
	it('accepts an empty payload (defaults)', () => {
		const r = dispatchCommandSchema.safeParse({ type: 'reboot' });
		expect(r.success).toBe(true);
	});

	it('accepts delaySeconds and message', () => {
		const r = dispatchCommandSchema.safeParse({
			type: 'reboot',
			payload: { delaySeconds: 600, message: 'Patching window' }
		});
		expect(r.success).toBe(true);
	});

	it('rejects negative delaySeconds', () => {
		const r = dispatchCommandSchema.safeParse({
			type: 'reboot', payload: { delaySeconds: -1 }
		});
		expect(r.success).toBe(false);
	});

	it('rejects delaySeconds beyond 24h', () => {
		const r = dispatchCommandSchema.safeParse({
			type: 'reboot', payload: { delaySeconds: 86401 }
		});
		expect(r.success).toBe(false);
	});

	it('rejects non-numeric delaySeconds', () => {
		const r = dispatchCommandSchema.safeParse({
			type: 'reboot', payload: { delaySeconds: '600' }
		});
		expect(r.success).toBe(false);
	});

	it('rejects message > 200 chars', () => {
		const r = dispatchCommandSchema.safeParse({
			type: 'reboot', payload: { message: 'x'.repeat(201) }
		});
		expect(r.success).toBe(false);
	});
});
