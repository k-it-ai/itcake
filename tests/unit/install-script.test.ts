/**
 * End-to-end checks for install.sh's non-interactive decision logic.
 *
 * The installer is the first thing a self-hoster runs, and its failure modes
 * are expensive: a missing ORIGIN makes the app refuse to start, a relative
 * DATA_DIR breaks systemd's ReadWritePaths, and an over-hardened unit blocks
 * Chromium's sandbox. These tests run the real script in a temp directory with
 * npm/npx/sudo stubbed out, so no network or system changes occur.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';

const INSTALLER = path.resolve('install.sh');
const BASH = existsSync('/opt/homebrew/bin/bash') ? '/opt/homebrew/bin/bash' : 'bash';
const describeInstaller = process.platform === 'win32' ? describe.skip : describe;

let dir: string;
let binDir: string;
let commandLog: string;

function stub(name: string) {
	const file = path.join(binDir, name);
	writeFileSync(file, `#!/bin/sh
if [ "$(basename "$0")" = "sudo" ] && [ "$1" = "test" ]; then exit 1; fi
if [ "$(basename "$0")" = "sudo" ] && [ "$1" = "grep" ]; then exit 1; fi
if [ "$(basename "$0")" = "sudo" ] && [ "$1" = "tee" ]; then
  shift
  [ "$1" = "-a" ] && shift
  echo "### $1" >> "$INSTALL_LOG.tee"
  while IFS= read -r line; do echo "$line" >> "$INSTALL_LOG.tee"; done
fi
echo "$(basename "$0") $* PUPPETEER_CACHE_DIR=\${PUPPETEER_CACHE_DIR:-}" >> "$INSTALL_LOG"
exit 0
`);
	chmodSync(file, 0o755);
}

function runInstall(input: string) {
	return spawnSync(BASH, [INSTALLER], {
		cwd: dir,
		input,
		env: {
			...process.env,
			PATH: `${binDir}:${process.env.PATH ?? ''}`,
			INSTALL_LOG: commandLog
		},
		encoding: 'utf8',
		timeout: 30_000
	});
}

function envFile(): string {
	return readFileSync(path.join(dir, '.env'), 'utf8');
}

function envMap(): Record<string, string> {
	const out: Record<string, string> = {};
	for (const line of envFile().split('\n')) {
		const match = line.match(/^([A-Z0-9_]+)=(.*)$/);
		if (match) out[match[1]] = match[2];
	}
	return out;
}

function file(name: string): string {
	const target = path.join(dir, name);
	return existsSync(target) ? readFileSync(target, 'utf8') : '';
}

describeInstaller('install.sh', () => {
	beforeEach(() => {
		dir = mkdtempSync(path.join(process.cwd(), 'data-test-install-'));
		binDir = path.join(dir, 'bin');
		commandLog = path.join(dir, 'commands.log');
		mkdirSync(binDir, { recursive: true });
		for (const name of ['npm', 'npx', 'sudo', 'systemctl', 'caddy']) stub(name);
	});

	afterEach(() => {
		if (dir && existsSync(dir)) rmSync(dir, { recursive: true, force: true });
	});

	it('creates a production .env with absolute paths and retries an invalid origin', () => {
		const result = runInstall('\n\n\nhttps://invoices.example.com/\nhttps://invoices.example.com\nn\nn\n');
		expect(result.status, result.stderr).toBe(0);
		expect(result.stdout + result.stderr).toContain('trailing slash');

		const env = envMap();
		expect(env.ORIGIN).toBe('https://invoices.example.com');
		expect(env.DATA_DIR).toBe(path.join(dir, 'data'));
		expect(env.DATABASE_PATH).toBe(path.join(dir, 'data', 'itcake.db'));
		expect(env.PUPPETEER_CACHE_DIR).toBe(path.join(dir, 'data', 'puppeteer'));
		expect(env.NODE_ENV).toBe('production');
		expect(env.SESSION_SECRET).toMatch(/^[0-9a-f]{64}$/);
		expect(env.FIELD_ENCRYPTION_KEY).toMatch(/^[0-9a-f]{64}$/);
		expect(statSync(path.join(dir, '.env')).mode & 0o777).toBe(0o600);

		const commands = file('commands.log');
		expect(commands).toMatch(/^npm ci .*PUPPETEER_CACHE_DIR=.*\/data\/puppeteer$/m);
		expect(commands).toMatch(/^npx puppeteer browsers install chrome .*PUPPETEER_CACHE_DIR=.*\/data\/puppeteer$/m);
		expect(commands).toMatch(/^npm run build /m);
	}, 20_000);

	it('upgrades an existing .env without ORIGIN/PUPPETEER_CACHE_DIR without aborting', () => {
		writeFileSync(path.join(dir, '.env'), [
			'DATABASE_PATH=data-old/itcake.db',
			'DATA_DIR=data-old',
			'HOST=127.0.0.1',
			'PORT=3100',
			'NODE_ENV=production',
			'SESSION_SECRET=0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
			''
		].join('\n'), { mode: 0o600 });

		// Answer "no" to overwriting, then provide the missing ORIGIN.
		const result = runInstall('n\nhttps://upgrade.example.com\nn\nn\n');
		expect(result.status, result.stderr).toBe(0);

		const env = envMap();
		expect(env.DATA_DIR).toBe('data-old');
		expect(env.ORIGIN).toBe('https://upgrade.example.com');
		expect(env.PUPPETEER_CACHE_DIR).toBe(path.join(dir, 'data-old', 'puppeteer'));
		expect(env.FIELD_ENCRYPTION_KEY).toMatch(/^[0-9a-f]{64}$/);
		expect(existsSync(path.join(dir, 'data-old', 'uploads'))).toBe(true);
		expect(existsSync(path.join(dir, 'data-old', 'puppeteer'))).toBe(true);
		expect(statSync(path.join(dir, '.env')).mode & 0o777).toBe(0o600);
	}, 20_000);

	it('aligns ORIGIN/ADDRESS_HEADER with Caddy and emits a Chromium-safe unit', () => {
		const result = runInstall('\n\n\nhttp://127.0.0.1:3000\ny\ninvoices.example.com\ny\ny\n');
		expect(result.status, result.stderr).toBe(0);

		const env = envMap();
		expect(env.ORIGIN).toBe('https://invoices.example.com');
		expect(env.ADDRESS_HEADER).toBe('X-Forwarded-For');

		const tee = file('commands.log.tee');
		expect(tee).toContain('invoices.example.com {');
		expect(tee).toContain('reverse_proxy 127.0.0.1:3000');

		const unit = tee;
		expect(unit).toContain(`EnvironmentFile="${dir}/.env"`);
		expect(unit).toContain(`Environment="HOME=${dir}/data"`);
		expect(unit).toContain('ProtectHome=read-only');
		expect(unit).toContain(`ReadWritePaths="${dir}/data"`);
		expect(unit).toContain(`ExecStart="`);
		expect(unit).toContain(`build/index.js"`);
		expect(unit).toContain('NoNewPrivileges=true');
		expect(unit).toContain('RestrictAddressFamilies=AF_UNIX AF_INET AF_INET6 AF_NETLINK');
		// Blanket namespace/syscall restrictions break Chromium's sandbox.
		expect(unit).not.toMatch(/^RestrictNamespaces=/m);
		expect(unit).not.toMatch(/^SystemCallFilter=/m);
	}, 20_000);
});
