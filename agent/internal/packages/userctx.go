//go:build !windows

package packages

import (
	"os"
	"os/exec"
	"runtime"
	"strings"
)

// consoleUser caches the detected non-root user who owns brew/GUI tools.
var consoleUser string

func init() {
	consoleUser = detectConsoleUser()
}

// ConsoleUser returns the logged-in non-root user. Empty if detection fails or not root.
func ConsoleUser() string {
	return consoleUser
}

func detectConsoleUser() string {
	// Only needed when running as root
	if os.Getuid() != 0 {
		return ""
	}

	if runtime.GOOS == "darwin" {
		// macOS: stat the console device to find the logged-in user
		out, err := exec.Command("/usr/bin/stat", "-f", "%Su", "/dev/console").Output()
		if err == nil {
			user := strings.TrimSpace(string(out))
			if user != "" && user != "root" {
				return user
			}
		}
		// Fallback: find the owner of the brew binary
		for _, brewPath := range []string{"/opt/homebrew/bin/brew", "/usr/local/bin/brew"} {
			out, err := exec.Command("/usr/bin/stat", "-f", "%Su", brewPath).Output()
			if err == nil {
				user := strings.TrimSpace(string(out))
				if user != "" && user != "root" {
					return user
				}
			}
		}
	}

	if runtime.GOOS == "linux" {
		// Linux: check SUDO_USER or logname
		if user := os.Getenv("SUDO_USER"); user != "" && user != "root" {
			return user
		}
		out, err := exec.Command("logname").Output()
		if err == nil {
			user := strings.TrimSpace(string(out))
			if user != "" && user != "root" {
				return user
			}
		}
	}

	return ""
}

