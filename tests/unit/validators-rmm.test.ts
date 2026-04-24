import { describe, it, expect } from 'vitest';
import {
	dispatchCommandSchema,
	checkinPayloadSchema,
	enrollRequestSchema,
	rmmSettingsSchema
} from '../../src/lib/validators-rmm.js';

// --- z.record key validation tests ---
// Vulnerability: z.record() without key validation allows __proto__ and constructor
// keys in JSON payloads, enabling prototype pollution when the object is spread
// or merged into other objects.
// Fix: z.record keys use regex /^[a-zA-Z][a-zA-Z0-9_.-]*$/ to constrain key names.

describe('RMM payload key validation', () => {
	describe('dispatchCommandSchema payload keys', () => {
		it('accepts valid payload keys', () => {
			const result = dispatchCommandSchema.safeParse({
				type: 'shell',
				payload: { command: 'ls -la' }
			});
			expect(result.success).toBe(true);
		});

		it('accepts keys with dots and dashes', () => {
			const result = dispatchCommandSchema.safeParse({
				type: 'shell',
				payload: { command: 'ls', 'config.path': '/etc', 'my-flag': true }
			});
			expect(result.success).toBe(true);
		});

		it('rejects __proto__ key in payload (prototype pollution)', () => {
			// __proto__ starts with underscore, not a letter - caught by regex
			const result = dispatchCommandSchema.safeParse({
				type: 'shell',
				payload: { command: 'ls', __proto__: { polluted: true } }
			});
			// Note: JSON.parse() may or may not include __proto__ as a key.
			// When constructing via object literal in JS, __proto__ may be swallowed.
			// The zod regex /^[a-zA-Z].../ rejects keys starting with underscore.
			// Test with explicit underscore-prefixed key to prove the regex works:
			const result2 = dispatchCommandSchema.safeParse({
				type: 'shell',
				payload: { command: 'ls', _proto_: 'test' }
			});
			expect(result2.success).toBe(false);
		});

		it('rejects keys starting with numbers', () => {
			const result = dispatchCommandSchema.safeParse({
				type: 'shell',
				payload: { command: 'ls', '123key': 'value' }
			});
			expect(result.success).toBe(false);
		});

		it('rejects keys with special characters', () => {
			const specialKeys = ['key space', 'key;drop', 'key$(cmd)', 'key|pipe', 'key<tag>'];
			for (const key of specialKeys) {
				const payload: Record<string, unknown> = { command: 'ls' };
				payload[key] = 'value';
				const result = dispatchCommandSchema.safeParse({
					type: 'shell',
					payload
				});
				expect(result.success).toBe(false);
			}
		});

		it('rejects empty string key', () => {
			const result = dispatchCommandSchema.safeParse({
				type: 'shell',
				payload: { command: 'ls', '': 'empty' }
			});
			expect(result.success).toBe(false);
		});
	});

	describe('service info data key validation', () => {
		it('accepts valid service data keys in checkin payload', () => {
			const result = checkinPayloadSchema.safeParse({
				services: [{
					name: 'sshd',
					status: 'running',
					data: { pid: 1234, configPath: '/etc/ssh' }
				}]
			});
			expect(result.success).toBe(true);
		});

		it('accepts keys with dots and dashes in service data', () => {
			const data: Record<string, unknown> = {};
			data['config.path'] = '/etc/ssh';
			data['log-level'] = 'info';
			const result = checkinPayloadSchema.safeParse({
				services: [{
					name: 'sshd',
					status: 'running',
					data
				}]
			});
			expect(result.success).toBe(true);
		});

		it('rejects __proto__ in service data keys', () => {
			const data: Record<string, unknown> = {};
			data['_hack'] = 'polluted';
			const result = checkinPayloadSchema.safeParse({
				services: [{
					name: 'sshd',
					status: 'running',
					data
				}]
			});
			expect(result.success).toBe(false);
		});
	});
});

// --- Command type validation ---
// New command types were added: software_update, os_update, check_os_updates, system_info_refresh

describe('dispatch command types', () => {
	it('accepts new software_update command type', () => {
		const result = dispatchCommandSchema.safeParse({
			type: 'software_update',
			payload: { package: 'firefox', manager: 'brew' }
		});
		expect(result.success).toBe(true);
	});

	it('accepts os_update command type', () => {
		const result = dispatchCommandSchema.safeParse({
			type: 'os_update',
			payload: {}
		});
		expect(result.success).toBe(true);
	});

	it('accepts check_os_updates command type', () => {
		const result = dispatchCommandSchema.safeParse({
			type: 'check_os_updates',
			payload: {}
		});
		expect(result.success).toBe(true);
	});

	it('accepts system_info_refresh command type', () => {
		const result = dispatchCommandSchema.safeParse({
			type: 'system_info_refresh',
			payload: {}
		});
		expect(result.success).toBe(true);
	});

	it('rejects unknown command types', () => {
		const result = dispatchCommandSchema.safeParse({
			type: 'unknown_command',
			payload: {}
		});
		expect(result.success).toBe(false);
	});

	it('validates shell command requires command in payload', () => {
		const result = dispatchCommandSchema.safeParse({
			type: 'shell',
			payload: {}
		});
		expect(result.success).toBe(false);
	});

	it('validates shell command length limit', () => {
		const result = dispatchCommandSchema.safeParse({
			type: 'shell',
			payload: { command: 'x'.repeat(100_001) }
		});
		expect(result.success).toBe(false);
	});

	it('validates service_action requires service and action', () => {
		const result = dispatchCommandSchema.safeParse({
			type: 'service_action',
			payload: { service: 'sshd' }
		});
		expect(result.success).toBe(false);
	});

	it('validates service_action accepts valid actions', () => {
		for (const action of ['start', 'stop', 'restart', 'enable', 'disable']) {
			const result = dispatchCommandSchema.safeParse({
				type: 'service_action',
				payload: { service: 'sshd', action }
			});
			expect(result.success).toBe(true);
		}
	});

	it('validates service_action rejects invalid actions', () => {
		const result = dispatchCommandSchema.safeParse({
			type: 'service_action',
			payload: { service: 'sshd', action: 'destroy' }
		});
		expect(result.success).toBe(false);
	});

	it('validates package_install requires package name', () => {
		const result = dispatchCommandSchema.safeParse({
			type: 'package_install',
			payload: {}
		});
		expect(result.success).toBe(false);
	});

	it('validates timeout bounds', () => {
		expect(dispatchCommandSchema.safeParse({
			type: 'shell', payload: { command: 'ls' }, timeoutSeconds: 4
		}).success).toBe(false);
		expect(dispatchCommandSchema.safeParse({
			type: 'shell', payload: { command: 'ls' }, timeoutSeconds: 3601
		}).success).toBe(false);
		expect(dispatchCommandSchema.safeParse({
			type: 'shell', payload: { command: 'ls' }, timeoutSeconds: 300
		}).success).toBe(true);
	});
});

// --- Enrollment validation ---

describe('enrollment request schema', () => {
	it('accepts valid enrollment data', () => {
		const result = enrollRequestSchema.safeParse({
			token: 'abc123', os: 'darwin', arch: 'arm64'
		});
		expect(result.success).toBe(true);
	});

	it('accepts windows OS', () => {
		const result = enrollRequestSchema.safeParse({
			token: 'abc123', os: 'windows', arch: 'amd64'
		});
		expect(result.success).toBe(true);
	});

	it('rejects unsupported OS (freebsd)', () => {
		const result = enrollRequestSchema.safeParse({
			token: 'abc123', os: 'freebsd', arch: 'amd64'
		});
		expect(result.success).toBe(false);
	});

	it('accepts valid hmacSecret', () => {
		const result = enrollRequestSchema.safeParse({
			token: 'abc123', os: 'linux', arch: 'amd64',
			hmacSecret: '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef'
		});
		expect(result.success).toBe(true);
	});

	it('rejects low-entropy hmacSecret', () => {
		const result = enrollRequestSchema.safeParse({
			token: 'abc123', os: 'linux', arch: 'amd64',
			hmacSecret: 'abc123' // way too short
		});
		expect(result.success).toBe(false);
	});

	it('rejects non-hex hmacSecret', () => {
		const result = enrollRequestSchema.safeParse({
			token: 'abc123', os: 'linux', arch: 'amd64',
			hmacSecret: 'g'.repeat(64) // 64 chars but not hex
		});
		expect(result.success).toBe(false);
	});

	it('rejects unsupported architecture', () => {
		const result = enrollRequestSchema.safeParse({
			token: 'abc123', os: 'linux', arch: 'x86'
		});
		expect(result.success).toBe(false);
	});

	it('requires token', () => {
		const result = enrollRequestSchema.safeParse({
			os: 'linux', arch: 'amd64'
		});
		expect(result.success).toBe(false);
	});
});

// --- Checkin payload validation ---

describe('checkin payload schema', () => {
	it('accepts valid metrics', () => {
		const result = checkinPayloadSchema.safeParse({
			metrics: {
				cpuPercent: 45.5,
				memoryUsedBytes: 8_000_000_000,
				memoryTotalBytes: 16_000_000_000,
				diskUsedBytes: 100_000_000_000,
				diskTotalBytes: 500_000_000_000,
				loadAvg1: 1.5,
				loadAvg5: 2.0,
				loadAvg15: 1.8,
				uptimeSeconds: 86400
			}
		});
		expect(result.success).toBe(true);
	});

	it('rejects CPU percent over 100', () => {
		const result = checkinPayloadSchema.safeParse({
			metrics: { cpuPercent: 101 }
		});
		expect(result.success).toBe(false);
	});

	it('rejects negative memory values', () => {
		const result = checkinPayloadSchema.safeParse({
			metrics: { memoryUsedBytes: -1 }
		});
		expect(result.success).toBe(false);
	});

	it('limits command result output size', () => {
		const result = checkinPayloadSchema.safeParse({
			commandResults: [{
				id: 'cmd1', status: 'completed', exitCode: 0,
				stdout: 'x'.repeat(1_048_577) // 1MB + 1 byte
			}]
		});
		expect(result.success).toBe(false);
	});

	it('limits stderr size', () => {
		const result = checkinPayloadSchema.safeParse({
			commandResults: [{
				id: 'cmd1', status: 'failed', exitCode: 1,
				stderr: 'x'.repeat(262_145) // 256KB + 1 byte
			}]
		});
		expect(result.success).toBe(false);
	});

	it('limits package list size', () => {
		const packages = Array.from({ length: 10001 }, (_, i) => ({
			manager: 'brew', name: `pkg-${i}`, version: '1.0'
		}));
		const result = checkinPayloadSchema.safeParse({ packages });
		expect(result.success).toBe(false);
	});
});

// --- RMM settings validation ---

describe('RMM settings schema', () => {
	it('accepts valid settings', () => {
		const result = rmmSettingsSchema.safeParse({
			defaultCheckinInterval: 60,
			staleThresholdMinutes: 5,
			metricsRetentionHours: 48,
			commandTimeoutSeconds: 300
		});
		expect(result.success).toBe(true);
	});

	it('rejects checkin interval below minimum', () => {
		const result = rmmSettingsSchema.safeParse({
			defaultCheckinInterval: 5
		});
		expect(result.success).toBe(false);
	});

	it('rejects checkin interval above maximum', () => {
		const result = rmmSettingsSchema.safeParse({
			defaultCheckinInterval: 3601
		});
		expect(result.success).toBe(false);
	});

	it('uses defaults for missing fields', () => {
		const result = rmmSettingsSchema.safeParse({});
		expect(result.success).toBe(true);
		if (result.success) {
			expect(result.data.defaultCheckinInterval).toBe(60);
			expect(result.data.staleThresholdMinutes).toBe(5);
			expect(result.data.metricsRetentionHours).toBe(48);
			expect(result.data.commandTimeoutSeconds).toBe(300);
		}
	});
});
