import { describe, it, expect } from 'vitest';
import {
	agentRemoteDesktopSchema,
	remoteDesktopSettingsSchema
} from '../../src/lib/validators-rmm.js';

describe('agentRemoteDesktopSchema', () => {
	it('accepts a minimal RDP profile', () => {
		const r = agentRemoteDesktopSchema.safeParse({
			protocol: 'rdp', port: 3389
		});
		expect(r.success).toBe(true);
	});

	it('accepts a fully-specified RDP profile', () => {
		const r = agentRemoteDesktopSchema.safeParse({
			protocol: 'rdp', port: 3389,
			username: 'Administrator', password: 'pa$$',
			domain: 'corp.local', ignoreCert: true, recording: true
		});
		expect(r.success).toBe(true);
	});

	it('accepts SSH with a private key', () => {
		const r = agentRemoteDesktopSchema.safeParse({
			protocol: 'ssh', port: 22, username: 'root',
			privateKey: '-----BEGIN OPENSSH PRIVATE KEY-----\nfake-key\n-----END OPENSSH PRIVATE KEY-----'
		});
		expect(r.success).toBe(true);
	});

	it('rejects unknown protocol', () => {
		const r = agentRemoteDesktopSchema.safeParse({
			protocol: 'telnet', port: 23
		});
		expect(r.success).toBe(false);
	});

	it('rejects out-of-range port', () => {
		const r = agentRemoteDesktopSchema.safeParse({
			protocol: 'rdp', port: 0
		});
		expect(r.success).toBe(false);
	});

	it('rejects oversize private key', () => {
		const r = agentRemoteDesktopSchema.safeParse({
			protocol: 'ssh', port: 22,
			privateKey: 'x'.repeat(20001)
		});
		expect(r.success).toBe(false);
	});
});

describe('remoteDesktopSettingsSchema', () => {
	it('accepts the seeded defaults', () => {
		const r = remoteDesktopSettingsSchema.safeParse({
			enabled: false,
			guacdHost: '127.0.0.1', guacdPort: 4822,
			proxyPort: 4823,
			recordingEnabled: false,
			maxSessionMinutes: 60,
			tokenTtlSeconds: 300
		});
		expect(r.success).toBe(true);
	});

	it('rejects proxyPort < 1024 (privileged)', () => {
		const r = remoteDesktopSettingsSchema.safeParse({
			enabled: true, guacdHost: '127.0.0.1', guacdPort: 4822,
			proxyPort: 80, recordingEnabled: false,
			maxSessionMinutes: 60, tokenTtlSeconds: 300
		});
		expect(r.success).toBe(false);
	});

	it('rejects tokenTtlSeconds outside bounds', () => {
		const r = remoteDesktopSettingsSchema.safeParse({
			enabled: true, guacdHost: '127.0.0.1', guacdPort: 4822,
			proxyPort: 4823, recordingEnabled: false,
			maxSessionMinutes: 60, tokenTtlSeconds: 0
		});
		expect(r.success).toBe(false);
	});

	it('rejects maxSessionMinutes > 24h', () => {
		const r = remoteDesktopSettingsSchema.safeParse({
			enabled: true, guacdHost: '127.0.0.1', guacdPort: 4822,
			proxyPort: 4823, recordingEnabled: false,
			maxSessionMinutes: 1500, tokenTtlSeconds: 300
		});
		expect(r.success).toBe(false);
	});
});
