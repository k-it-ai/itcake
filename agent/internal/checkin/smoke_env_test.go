package checkin

import (
	"os"
	"runtime"
	"strings"
	"testing"
)

// TestMinimalSmokeEnv_NoInherit verifies the self-update smoke test runs
// with a minimal env (PATH + on Windows SYSTEMROOT) rather than the
// agent's full process env. The agent runs as root/SYSTEM; pinning the
// env keeps the verification step reproducible regardless of how the
// service manager started us, and prevents a future contributor from
// inheriting attacker-influenced variables (a systemd drop-in, a stale
// .pkla, a launchd plist override) into the smoke step.
func TestMinimalSmokeEnv_NoInherit(t *testing.T) {
	// Plant a sentinel the smoke env MUST NOT carry. If the helper
	// regresses to inheriting the full env, this leaks through.
	const sentinel = "ITCAKE_SMOKE_ENV_TEST_SENTINEL"
	t.Setenv(sentinel, "must-not-leak")

	env := minimalSmokeEnv()
	for _, kv := range env {
		if strings.HasPrefix(kv, sentinel+"=") {
			t.Fatalf("smoke env unexpectedly carried %s — should be PATH (+ SYSTEMROOT on Windows) only; got %v", sentinel, env)
		}
	}

	hasPath := false
	for _, kv := range env {
		if strings.HasPrefix(kv, "PATH=") {
			hasPath = true
			break
		}
	}
	if !hasPath {
		t.Fatalf("smoke env missing PATH; got %v", env)
	}

	if runtime.GOOS == "windows" {
		// SYSTEMROOT is mandatory for the Go runtime on Windows. If the
		// agent's process env doesn't carry it (impossible in service
		// context, but defensive), the helper should still produce a
		// sensible env even if SYSTEMROOT can't be propagated.
		if os.Getenv("SYSTEMROOT") != "" {
			found := false
			for _, kv := range env {
				if strings.HasPrefix(kv, "SYSTEMROOT=") {
					found = true
					break
				}
			}
			if !found {
				t.Fatal("smoke env on Windows must include SYSTEMROOT when the process env has it")
			}
		}
	}
}
