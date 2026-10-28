#!/usr/bin/env node
/**
 * Security-audit runner. Invoked weekly from .github/workflows/security-audit.yml.
 *
 * What it does:
 *   1. Runs `npm audit --json` and parses vulnerabilities.
 *   2. Runs `npm outdated --json` for outdated packages.
 *   3. Runs `go list -m -u all` in agent/ for outdated Go modules.
 *   4. Filters out advisory IDs listed in .github/acknowledged-advisories.json
 *      and outdated packages listed in .github/acknowledged-outdated.json.
 *   5. For HIGH/CRITICAL with a patched version: branches `chore/deps/<pkg>-<date>`,
 *      bumps the package, pushes, opens a PR, and dispatches CI for that
 *      branch (GITHUB_TOKEN-created PRs do not trigger pull_request runs).
 *   6. For MODERATE/LOW + outdated deps: writes a single rolling issue
 *      titled `Dependency status — YYYY-MM` (creates if missing, otherwise
 *      replaces body).
 *
 * Inputs come from env (set by the workflow):
 *   GH_TOKEN — for `gh` CLI auth
 *   REPO     — owner/name (e.g. kossov-it/itcake)
 *
 * No user-controlled input is interpolated into shell commands. PR/issue
 * bodies go through `gh ... --body-file` (file inputs, never -b "..." with
 * shell interpolation) so a vulnerability NAME containing $(...) can't
 * escape into the runner.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const REPO = process.env.REPO || 'kossov-it/itcake';
const TODAY = new Date().toISOString().slice(0, 10);
const YEAR_MONTH = TODAY.slice(0, 7);

function run(file, args, opts = {}) {
	try {
		return execFileSync(file, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], ...opts });
	} catch (e) {
		// Many CLIs (npm audit, go list) exit non-zero when they have findings.
		// Return whatever they wrote to stdout/stderr so the caller can decide.
		return (e.stdout?.toString?.() ?? '') || (e.stderr?.toString?.() ?? '');
	}
}

function gh(args, opts) {
	return execFileSync('gh', args, { encoding: 'utf8', stdio: ['pipe', 'pipe', 'inherit'], ...opts });
}

function loadAcknowledged() {
	try {
		const raw = JSON.parse(readFileSync('.github/acknowledged-advisories.json', 'utf8'));
		return new Set((raw.advisories || []).map(a => a.id));
	} catch {
		return new Set();
	}
}

function loadOutdatedAcknowledged() {
	try {
		const raw = JSON.parse(readFileSync('.github/acknowledged-outdated.json', 'utf8'));
		return new Map((raw.packages || []).map(p => [p.name, p]));
	} catch {
		return new Map();
	}
}

function npmAudit() {
	const out = run('npm', ['audit', '--json']);
	try {
		const parsed = JSON.parse(out);
		return parsed.vulnerabilities || {};
	} catch {
		return {};
	}
}

function npmOutdated() {
	const out = run('npm', ['outdated', '--json']);
	try {
		// `npm outdated` returns {} when nothing's outdated (and exits 1 when
		// something is). Treat parse failure as "nothing".
		return JSON.parse(out || '{}');
	} catch {
		return {};
	}
}

function goOutdated() {
	const out = run('go', ['list', '-m', '-u', '-json', 'all'], { cwd: 'agent' });
	const updates = [];
	// `go list -json` produces a stream of JSON objects, NOT a single array.
	// Split on top-level brace pairs.
	let depth = 0;
	let buf = '';
	for (const ch of out) {
		if (ch === '{') depth++;
		if (ch === '}') depth--;
		buf += ch;
		if (depth === 0 && buf.trim()) {
			try {
				const m = JSON.parse(buf);
				if (m.Update) {
					updates.push({
						path: m.Path,
						current: m.Version,
						latest: m.Update.Version
					});
				}
			} catch { /* skip non-JSON whitespace between blocks */ }
			buf = '';
		}
	}
	return updates;
}

function classifyAdvisories(vulnerabilities, acknowledged) {
	const high = [];   // severity high|critical with available fix
	const other = [];  // moderate/low, or no fix available
	const ack = [];

	for (const [pkg, vuln] of Object.entries(vulnerabilities)) {
		const sources = (vuln.via || []).filter(v => typeof v === 'object');
		for (const s of sources) {
			const ackHit = s.url && [...acknowledged].some(id => s.url.includes(id));
			const entry = {
				pkg,
				title: s.title,
				severity: s.severity,
				url: s.url,
				cwe: s.cwe,
				patchedRange: vuln.fixAvailable && typeof vuln.fixAvailable === 'object' ? vuln.fixAvailable.version : null,
				directlyFixable: vuln.fixAvailable === true || (typeof vuln.fixAvailable === 'object' && vuln.fixAvailable.name === pkg)
			};
			if (ackHit) {
				ack.push(entry);
				continue;
			}
			if ((s.severity === 'high' || s.severity === 'critical') && entry.directlyFixable) {
				high.push(entry);
			} else {
				other.push(entry);
			}
		}
	}
	return { high, other, ack };
}

function existingBranch(name) {
	try {
		execFileSync('git', ['ls-remote', '--exit-code', '--heads', 'origin', name], { stdio: 'ignore' });
		return true;
	} catch {
		return false;
	}
}

function existingPr(headBranch) {
	try {
		const out = gh(['pr', 'list', '--repo', REPO, '--head', headBranch, '--json', 'number,state', '--limit', '1']);
		const arr = JSON.parse(out);
		return arr.length > 0 ? arr[0] : null;
	} catch {
		return null;
	}
}

function createBumpPr(entry) {
	const branch = `chore/deps/${entry.pkg}-${TODAY}`;
	if (existingBranch(branch)) {
		console.log(`[audit] branch ${branch} already exists — skipping`);
		return null;
	}
	if (existingPr(branch)) {
		console.log(`[audit] PR for ${branch} already open — skipping`);
		return null;
	}

	try {
		execFileSync('git', ['checkout', '-B', branch], { stdio: 'inherit' });
		// Use `npm install <pkg>` — npm picks the latest range that satisfies
		// peer constraints. For deeper transitive issues you'd need `npm audit
		// fix --force`, but that's intentionally not auto-run (breaking).
		execFileSync('npm', ['install', entry.pkg], { stdio: 'inherit' });

		const status = execFileSync('git', ['status', '--porcelain'], { encoding: 'utf8' });
		if (!status.trim()) {
			console.log(`[audit] no changes after npm install ${entry.pkg} — skipping PR`);
			execFileSync('git', ['checkout', '-'], { stdio: 'inherit' });
			return null;
		}

		execFileSync('git', ['add', 'package.json', 'package-lock.json'], { stdio: 'inherit' });
		const commitMsg = `deps: bump ${entry.pkg} (${entry.severity}) — fixes ${entry.url}`;
		execFileSync('git', ['commit', '-m', commitMsg], { stdio: 'inherit' });
		execFileSync('git', ['push', '-u', 'origin', branch], { stdio: 'inherit' });

		// Body via temp file so nothing user-supplied lands on a shell line.
		const body = [
			`## Automated security bump`,
			``,
			`- **Package:** \`${entry.pkg}\``,
			`- **Severity:** ${entry.severity}`,
			`- **Title:** ${entry.title}`,
			`- **Advisory:** ${entry.url}`,
			``,
			`Generated by \`.github/workflows/security-audit.yml\` from \`npm audit\`.`,
			``,
			`Tests are dispatched by the audit workflow with \`workflow_dispatch\` because PRs created with \`GITHUB_TOKEN\` do not trigger \`pull_request\` workflows. Review carefully before merging — patched versions can ship behavior changes.`
		].join('\n');
		const dir = mkdtempSync(path.join(tmpdir(), 'audit-'));
		const bodyFile = path.join(dir, 'body.md');
		writeFileSync(bodyFile, body, 'utf8');

		gh([
			'pr', 'create', '--repo', REPO,
			'--head', branch, '--base', 'main',
			'--title', `deps: bump ${entry.pkg} (${entry.severity})`,
			'--body-file', bodyFile,
			'--label', 'dependencies', '--label', 'security'
		], { stdio: 'inherit' });

		// A PR created with GITHUB_TOKEN does not emit a pull_request event,
		// so dispatch CI explicitly. The workflow_dispatch run compares the
		// branch against the default branch, running the right path-gated
		// jobs and reporting the required "CI success" check.
		try {
			gh(['workflow', 'run', 'ci.yml', '--repo', REPO, '--ref', branch], { stdio: 'inherit' });
			console.log(`[audit] dispatched CI for ${branch}`);
		} catch (e) {
			console.warn(`[audit] could not dispatch CI for ${branch}:`, e instanceof Error ? e.message : e);
		}

		execFileSync('git', ['checkout', '-'], { stdio: 'inherit' });
		return branch;
	} catch (e) {
		console.error(`[audit] failed to create PR for ${entry.pkg}:`, e instanceof Error ? e.message : e);
		try { execFileSync('git', ['checkout', '-'], { stdio: 'inherit' }); } catch { /* ignore */ }
		return null;
	}
}

function findRollingIssue() {
	const title = `Dependency status — ${YEAR_MONTH}`;
	try {
		const out = gh([
			'issue', 'list', '--repo', REPO,
			'--search', `in:title "${title}"`,
			'--state', 'open',
			'--json', 'number,title', '--limit', '5'
		]);
		const arr = JSON.parse(out);
		const match = arr.find(i => i.title === title);
		return match ? match.number : null;
	} catch {
		return null;
	}
}

function upsertRollingIssue(body) {
	const title = `Dependency status — ${YEAR_MONTH}`;
	const dir = mkdtempSync(path.join(tmpdir(), 'issue-'));
	const bodyFile = path.join(dir, 'body.md');
	writeFileSync(bodyFile, body, 'utf8');
	const existing = findRollingIssue();
	if (existing) {
		gh(['issue', 'edit', String(existing), '--repo', REPO, '--body-file', bodyFile], { stdio: 'inherit' });
		return existing;
	}
	const out = gh([
		'issue', 'create', '--repo', REPO,
		'--title', title,
		'--body-file', bodyFile,
		'--label', 'dependencies'
	], { stdio: 'inherit' });
	return out;
}

function fmtAdvisory(e) {
	return `- ${e.severity.toUpperCase()} \`${e.pkg}\` — ${e.title}${e.url ? ` ([advisory](${e.url}))` : ''}`;
}

function main() {
	console.log(`[audit] running for ${REPO} on ${TODAY}`);
	const acknowledged = loadAcknowledged();
	const outdatedAck = loadOutdatedAcknowledged();
	console.log(`[audit] ${acknowledged.size} acknowledged advisor(y|ies), ${outdatedAck.size} deferred outdated package(s)`);

	const audit = npmAudit();
	const outdatedAll = npmOutdated();
	const outdated = Object.fromEntries(Object.entries(outdatedAll).filter(([pkg]) => !outdatedAck.has(pkg)));
	const deferredOutdated = Object.entries(outdatedAll).filter(([pkg]) => outdatedAck.has(pkg));
	const goUpd = goOutdated();
	const { high, other, ack } = classifyAdvisories(audit, acknowledged);

	console.log(`[audit] high/critical fixable: ${high.length}, deferred: ${other.length}, acknowledged: ${ack.length}, npm outdated: ${Object.keys(outdated).length} (+${deferredOutdated.length} deferred), go outdated: ${goUpd.length}`);

	// 1. Auto-PR for high/critical fixable
	const pickedPkgs = new Set();
	const opened = [];
	for (const entry of high) {
		if (pickedPkgs.has(entry.pkg)) continue;
		pickedPkgs.add(entry.pkg);
		const branch = createBumpPr(entry);
		if (branch) opened.push({ pkg: entry.pkg, branch, severity: entry.severity });
	}

	// 2. Rolling issue body
	const lines = [
		`> Auto-generated by \`.github/workflows/security-audit.yml\` on ${TODAY}.`,
		`> This issue is overwritten in place each week of ${YEAR_MONTH}.`,
		``,
		`## High / critical with auto-PR`,
		opened.length ? opened.map(o => `- **${o.pkg}** (${o.severity}) → \`${o.branch}\``).join('\n') : '_none_',
		``,
		`## Deferred (moderate / low / no fix yet)`,
		other.length ? other.slice(0, 50).map(fmtAdvisory).join('\n') : '_none_',
		other.length > 50 ? `_…and ${other.length - 50} more_` : '',
		``,
		`## Acknowledged (filtered, see \`.github/acknowledged-advisories.json\`)`,
		ack.length ? ack.map(fmtAdvisory).join('\n') : '_none_',
		``,
		`## Outdated npm packages`,
		Object.keys(outdated).length
			? Object.entries(outdated).slice(0, 50).map(([pkg, info]) => {
					const i = info;
					return `- \`${pkg}\` — current \`${i.current}\` → wanted \`${i.wanted}\` → latest \`${i.latest}\``;
				}).join('\n')
			: '_none_',
		Object.keys(outdated).length > 50 ? `_…and ${Object.keys(outdated).length - 50} more_` : '',
		``,
		`## Outdated npm packages — deferred by policy`,
		deferredOutdated.length
			? deferredOutdated.map(([pkg, info]) => {
					const ackEntry = outdatedAck.get(pkg);
					return `- \`${pkg}\` — current \`${info.current}\` → latest \`${info.latest}\` — ${ackEntry.reason} (${ackEntry.review})`;
				}).join('\n')
			: '_none_',
		``,
		`## Outdated Go modules (in \`agent/\`)`,
		goUpd.length
			? goUpd.slice(0, 50).map(g => `- \`${g.path}\` — \`${g.current}\` → \`${g.latest}\``).join('\n')
			: '_none_',
		``
	].filter(Boolean).join('\n');

	upsertRollingIssue(lines);
	console.log(`[audit] done — opened ${opened.length} PR(s), updated rolling issue.`);
}

main();
