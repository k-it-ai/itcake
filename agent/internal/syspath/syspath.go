// Package syspath returns absolute paths for the system tools the agent
// shells out to. The agent runs as root / LocalSystem and prepends
// user-writable directories (homebrew, /usr/local/bin) to PATH for
// package-manager helpers. Without absolute pinning, an unprivileged
// console user who can write to one of those directories can plant a
// trojan `system_profiler` / `journalctl` / `wmic` and have it executed
// as root by the next agent check-in. Each helper returns the first
// existing path from a small candidate list. If no candidate exists we
// fall back to the unqualified name + a one-time stderr warning, so
// weird distros (with the tool reachable only via PATH) still work but
// at a clearly-degraded posture.
//
// User-installed tools (brew, npm, pip3, winget, choco, scoop) live in
// user-writable locations by design — Homebrew on Apple Silicon is owned
// by the console user, npm/pip global installs land in user-controlled
// prefixes, winget/choco/scoop ship as per-user shims. PATH-pinning these
// is only useful when there are multiple known absolute candidates (so
// we can deterministically pick one); otherwise we fall back to PATH
// lookup and accept that PATH-hijack is fundamental to the trust model
// of those tools. This trade-off is documented inline in each helper.
package syspath

import (
	"fmt"
	"os"
	"os/exec"
	"sync"
)

// pickFirstExisting returns the first candidate that resolves on disk.
// If none do, it returns fallback and emits one stderr warning per
// (toolName) so logs aren't spammed when a tool is permanently missing.
func pickFirstExisting(toolName string, candidates []string, fallback string) string {
	for _, p := range candidates {
		if _, err := os.Stat(p); err == nil {
			return p
		}
	}
	warnOnce(toolName, fallback)
	return fallback
}

// pickFirstExistingOrLookPath behaves like pickFirstExisting but, if no
// candidate resolves on disk, falls back to exec.LookPath before the
// unqualified name. Used for user-installed tools (brew/npm/pip/winget/
// choco/scoop) where the canonical install location is operator-chosen
// and the only sensible fallback is PATH lookup. PATH-hijack defense is
// already fundamentally degraded for these tools — pinning at least
// disambiguates between several known absolute candidates when more than
// one exists (e.g. /opt/homebrew/bin/brew vs /usr/local/bin/brew).
func pickFirstExistingOrLookPath(toolName string, candidates []string, fallback string) string {
	for _, p := range candidates {
		if _, err := os.Stat(p); err == nil {
			return p
		}
	}
	if p, err := exec.LookPath(fallback); err == nil {
		return p
	}
	warnOnce(toolName, fallback)
	return fallback
}

var (
	warnedMu sync.Mutex
	warned   = map[string]struct{}{}
)

func warnOnce(toolName, fallback string) {
	warnedMu.Lock()
	defer warnedMu.Unlock()
	if _, ok := warned[toolName]; ok {
		return
	}
	warned[toolName] = struct{}{}
	fmt.Fprintf(os.Stderr,
		"[syspath] WARNING: %s not found at any standard absolute path; "+
			"falling back to PATH lookup of %q. PATH-hijack defense degraded.\n",
		toolName, fallback)
}
