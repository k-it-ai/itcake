import { execFile } from 'node:child_process';
import { existsSync, mkdirSync, statSync, readdirSync } from 'node:fs';
import { resolve, join } from 'node:path';

const DATA_DIR = process.env.DATA_DIR || 'data';
const BINARY_DIR = resolve(join(DATA_DIR, 'agent-binaries'));
const AGENT_SRC_DIR = resolve('agent');

const VALID_TARGETS = new Set([
	'darwin-amd64', 'darwin-arm64', 'linux-amd64', 'linux-arm64'
]);

/** Mutex to prevent concurrent builds of the same target. */
const buildLocks = new Map<string, Promise<string | null>>();

/**
 * Check if a cached binary is stale by comparing its mtime against
 * the newest .go file in the agent source tree. Triggers rebuild
 * after app updates that change the Go agent code.
 */
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

/**
 * Get the path to a built agent binary, building it on demand if Go is available.
 * Returns the file path on success, null if the binary can't be built.
 */
export async function getOrBuildAgentBinary(os: string, arch: string): Promise<string | null> {
	const target = `${os}-${arch}`;
	if (!VALID_TARGETS.has(target)) return null;

	const filename = `itcake-agent-${target}`;
	const filePath = resolve(join(BINARY_DIR, filename));

	// Serve cached binary if it exists and is newer than source
	if (existsSync(filePath)) {
		if (!isStale(filePath)) return filePath;
		console.log(`[agent-build] Binary for ${target} is stale (source changed), rebuilding...`);
	}

	// Check if source exists
	if (!existsSync(join(AGENT_SRC_DIR, 'go.mod'))) return null;

	// Check if Go is available
	const goAvailable = await checkGoAvailable();
	if (!goAvailable) return null;

	// Deduplicate concurrent builds for the same target
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

		const env = {
			...process.env,
			CGO_ENABLED: '0',
			GOOS: os,
			GOARCH: arch
		};

		execFile(
			'go',
			['build', '-ldflags=-s -w', '-o', outputPath, './cmd/agent'],
			{ cwd: AGENT_SRC_DIR, env, timeout: 120_000 },
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

/**
 * Returns a human-readable error explaining why the binary can't be served.
 */
export async function diagnoseDownloadFailure(os: string, arch: string): Promise<string> {
	if (!existsSync(join(AGENT_SRC_DIR, 'go.mod'))) {
		return `Agent source code not found at ${AGENT_SRC_DIR}/. Ensure the 'agent/' directory exists in the project root.`;
	}

	const goAvailable = await checkGoAvailable();
	if (!goAvailable) {
		return `Go compiler not found. Install Go (https://go.dev/dl/) to enable automatic agent binary building, or place a pre-built binary at ${BINARY_DIR}/itcake-agent-${os}-${arch}`;
	}

	return `Build failed for ${os}/${arch}. Check server logs for details.`;
}
