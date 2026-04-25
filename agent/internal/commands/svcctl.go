package commands

import (
	"errors"
	"fmt"
	"regexp"
	"runtime"
)

// ValidServiceActions mirrors the server-side Zod allowlist. Kept exported so
// other packages can use it without hardcoding strings.
var ValidServiceActions = []string{"start", "stop", "restart", "enable", "disable"}

// Service names across systemd / launchd / SCM share a conservative charset.
// We disallow any shell metacharacter — the agent runs this through `sh -c`
// (Unix) or `cmd.exe /d /s /c` (Windows), so an unfiltered name would be
// command injection. The server-side Zod schema already constrains this;
// the agent re-validates as defense-in-depth.
var serviceNameRe = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9._@\-]{0,254}$`)

// BuildServiceCommand returns the shell command that performs `action` on
// service `name` for `goos` (uses runtime.GOOS when empty — test override).
// Returns a clear error on invalid input so the agent reports a clean
// failure instead of blindly running a broken command line.
//
//   Linux   → systemctl <action> <name>                   (systemd only)
//   macOS   → launchctl start/stop/kickstart/enable/disable
//   Windows → sc.exe start/stop/config ...                (restart = stop && start)
func BuildServiceCommand(goos, action, name string) (string, error) {
	if goos == "" {
		goos = runtime.GOOS
	}
	if !isValidAction(action) {
		return "", fmt.Errorf("invalid service action %q (allowed: start/stop/restart/enable/disable)", action)
	}
	if !serviceNameRe.MatchString(name) {
		return "", errors.New("invalid service name (allowed charset: [A-Za-z0-9._@-], 1–255 chars, must start alphanumeric)")
	}

	switch goos {
	case "linux":
		return fmt.Sprintf("systemctl %s %s", action, name), nil
	case "darwin":
		switch action {
		case "start":
			return fmt.Sprintf("launchctl start %s", name), nil
		case "stop":
			return fmt.Sprintf("launchctl stop %s", name), nil
		case "restart":
			// kickstart -k = stop-then-start on the system domain.
			return fmt.Sprintf("launchctl kickstart -k system/%s", name), nil
		case "enable":
			return fmt.Sprintf("launchctl enable system/%s", name), nil
		case "disable":
			return fmt.Sprintf("launchctl disable system/%s", name), nil
		}
	case "windows":
		switch action {
		case "start":
			return fmt.Sprintf(`sc.exe start "%s"`, name), nil
		case "stop":
			return fmt.Sprintf(`sc.exe stop "%s"`, name), nil
		case "restart":
			// `&` chains commands in cmd.exe. `sc stop` is synchronous enough that
			// the subsequent `sc start` generally wins — not perfect, but the best
			// portable option without a stop-poll loop.
			return fmt.Sprintf(`sc.exe stop "%s" & sc.exe start "%s"`, name, name), nil
		case "enable":
			// `start= auto` must have the space after `=` — SCM quirk.
			return fmt.Sprintf(`sc.exe config "%s" start= auto`, name), nil
		case "disable":
			return fmt.Sprintf(`sc.exe config "%s" start= disabled`, name), nil
		}
	}
	return "", fmt.Errorf("unsupported OS %q for service_action", goos)
}

func isValidAction(a string) bool {
	for _, x := range ValidServiceActions {
		if x == a {
			return true
		}
	}
	return false
}
