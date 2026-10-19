// Package syspath returns absolute paths for system tools the agent
// shells out to. The agent runs as root / LocalSystem with PATH extended
// to user-writable directories (brew, /usr/local/bin); without absolute
// pinning a planted journalctl/wmic/system_profiler would execute as root.
// User-installed tools (brew/npm/pip/winget/choco/scoop) fall back to
// PATH lookup since PATH-hijack is inherent to their trust model.
package syspath

import (
	"fmt"
	"os"
	"os/exec"
	"sync"
)

type toolDef struct {
	name       string
	paths      []string
	fallback   string
	useLookPath bool
}

// pickFirstExisting returns the first candidate on disk, or fallback + a
// one-time stderr warning per toolName.
func pickFirstExisting(toolName string, candidates []string, fallback string) string {
	for _, p := range candidates {
		if _, err := os.Stat(p); err == nil {
			return p
		}
	}
	warnOnce(toolName, fallback)
	return fallback
}

// pickFirstExistingOrLookPath falls through to exec.LookPath after candidates.
// Used for user-installed tools where PATH-hijack defense is inherent.
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

// Registry of all tools with their platform-specific paths.
// The actual accessor functions (Journalctl(), Systemctl(), etc.) are generated
// from this registry by the platform-specific files.
var toolRegistry = map[string]toolDef{}

// register adds a tool definition to the registry.
func register(def toolDef) {
	toolRegistry[def.name] = def
}

// Get returns the resolved path for a tool name.
func Get(name string) string {
	def, ok := toolRegistry[name]
	if !ok {
		// Not in registry — fall back to PATH lookup with warning
		warnOnce(name, name)
		return name
	}
	if def.useLookPath {
		return pickFirstExistingOrLookPath(def.name, def.paths, def.fallback)
	}
	return pickFirstExisting(def.name, def.paths, def.fallback)
}

// GetOrLookPath resolves a tool using candidates then exec.LookPath.
func GetOrLookPath(name string) string {
	def, ok := toolRegistry[name]
	if !ok {
		if p, err := exec.LookPath(name); err == nil {
			return p
		}
		warnOnce(name, name)
		return name
	}
	if def.useLookPath {
		return pickFirstExistingOrLookPath(def.name, def.paths, def.fallback)
	}
	return pickFirstExisting(def.name, def.paths, def.fallback)
}

// Ensure all tools are registered at init time.
func init() {
	// Register all tools from platform-specific files.
	// This ensures the registry is populated before first use.
	_ = toolRegistry
}