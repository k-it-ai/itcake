import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, statSync, readdirSync, readFileSync } from 'node:fs';
import { resolve, join } from 'node:path';

const DATA_DIR = process.env.DATA_DIR || 'data';
const BINARY_DIR = resolve(join(DATA_DIR, 'agent-binaries'));
const AGENT_SRC_DIR = resolve('agent');

const VALID_TARGETS = new Set([
	'darwin-amd64', 'darwin-arm64',
	'linux-amd64', 'linux-arm64',
	'windows-amd64', 'windows-arm64'
]);

const buildLocks = new Map<string, Promise<string | null>>();

function isStale(binaryPath: string): boolean {
	try {
		const binaryMtime = statSync(binaryPath).mtimeMs;
		const latestSource = getLatestSourceMtime(AGENT_SRC_DIR);
		return latestSource > binaryMtime;
	} catch {
		return false;
	}
}

function getLatestSourceMtime(dir: string): number {
	let latest = 0;
	try {
		for (const entry of readdirSync(dir, { withFileTypes: true })) {
			const fullPath = join(dir, entry.name);
			if (entry.isDirectory() && entry.name !== 'vendor' && entry.name !== '.git') {
				latest = Math.max(latest, getLatestSourceMtime(fullPath));
			} else if (entry.isFile() && (entry.name.endsWith('.go') || entry.name === 'go.mod' || entry.name === 'go.sum')) {
				latest = Math.max(latest, statSync(fullPath).mtimeMs);
			}
		}
	} catch { /* skip unreadable dirs */ }
	return latest;
}

export async function getOrBuildAgentBinary(os: string, arch: string): Promise<string | null> {
	const target = `${os}-${arch}`;
	if (!VALID_TARGETS.has(target)) return null;

	const suffix = os === 'windows' ? '.exe' : '';
	const filename = `itcake-agent-${target}${suffix}`;
	const filePath = resolve(join(BINARY_DIR, filename));

	if (existsSync(filePath)) {
		if (!isStale(filePath)) return filePath;
		console.log(`[agent-build] Binary for ${target} is stale (source changed), rebuilding...`);
	}

	if (!existsSync(join(AGENT_SRC_DIR, 'go.mod'))) return null;

	const goAvailable = await checkGoAvailable();
	if (!goAvailable) return null;

	const existing = buildLocks.get(target);
	if (existing) return existing;

	const buildPromise = buildAgent(os, arch, filePath);
	buildLocks.set(target, buildPromise);

	try {
		return await buildPromise;
	} finally {
		buildLocks.delete(target);
	}
}

function checkGoAvailable(): Promise<boolean> {
	return new Promise((resolve) => {
		execFile('go', ['version'], { timeout: 5000 }, (err) => {
			resolve(!err);
		});
	});
}

function buildAgent(os: string, arch: string, outputPath: string): Promise<string | null> {
	return new Promise((resolve) => {
		if (!existsSync(BINARY_DIR)) {
			mkdirSync(BINARY_DIR, { recursive: true });
		}

		console.log(`[agent-build] Building itcake-agent for ${os}/${arch}...`);

		const ldflags = `-s -w -X main.version=${getAgentVersion()}`;
		const args = [
			'build',
			'-trimpath',
			'-buildvcs=false',
			`-ldflags=${ldflags}`,
			'-o', outputPath,
			'./cmd/agent'
		];
		const env = {
			...process.env,
			CGO_ENABLED: '0',
			GOOS: os,
			GOARCH: arch,
			GOFLAGS: '-mod=readonly'
		};

		execFile(
			'go',
			args,
			{ cwd: AGENT_SRC_DIR, env, timeout: 180_000 },
			(err, _stdout, stderr) => {
				if (err) {
					console.error(`[agent-build] Build failed for ${os}/${arch}:`, stderr || err.message);
					resolve(null);
					return;
				}
				console.log(`[agent-build] Built itcake-agent for ${os}/${arch} successfully`);
				resolve(outputPath);
			}
		);
	});
}

let cachedVersion: string | null = null;
function getAgentVersion(): string {
	if (cachedVersion !== null) return cachedVersion;
	try {
		const pkg = JSON.parse(readFileSync(resolve('package.json'), 'utf-8')) as { version?: string };
		cachedVersion = pkg.version || 'dev';
	} catch {
		cachedVersion = 'dev';
	}
	return cachedVersion;
}

export async function diagnoseDownloadFailure(os: string, arch: string): Promise<string> {
	if (!existsSync(join(AGENT_SRC_DIR, 'go.mod'))) {
		return `Agent source code not found at ${AGENT_SRC_DIR}/. Ensure the 'agent/' directory exists in the project root.`;
	}

	const goAvailable = await checkGoAvailable();
	if (!goAvailable) {
		const suffix = os === 'windows' ? '.exe' : '';
		return `Go compiler not found. Install Go (https://go.dev/dl/) to enable automatic agent binary building, or place a pre-built binary at ${BINARY_DIR}/itcake-agent-${os}-${arch}${suffix}`;
	}

	return `Build failed for ${os}/${arch}. Check server logs for details.`;
}

const hashCache = new Map<string, { hash: string; mtimeMs: number }>();

export function getAgentBinaryHash(os: string, arch: string): string | null {
	const target = `${os}-${arch}`;
	const suffix = os === 'windows' ? '.exe' : '';
	const filePath = resolve(join(BINARY_DIR, `itcake-agent-${target}${suffix}`));
	if (!existsSync(filePath)) return null;

	try {
		const mtime = statSync(filePath).mtimeMs;
		const cached = hashCache.get(target);
		if (cached && cached.mtimeMs === mtime) return cached.hash;

		const hash = createHash('sha256').update(readFileSync(filePath)).digest('hex');
		hashCache.set(target, { hash, mtimeMs: mtime });
		return hash;
	} catch {
		return null;
	}
}
