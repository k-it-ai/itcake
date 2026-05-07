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
package syspath

import (
	"fmt"
	"os"
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
