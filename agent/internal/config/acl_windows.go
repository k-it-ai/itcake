//go:build windows

package config

import (
	"fmt"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
)

// lockdownPath grants only SYSTEM + Administrators on `path` (Windows
// 0o600 file modes are silently ignored by Go). Absolute icacls.exe
// path defends against PATH hijack.
func lockdownPath(path string) error {
	if runtime.GOOS != "windows" {
		return nil
	}
	systemRoot := getSystemRoot()
	icaclsExe := filepath.Join(systemRoot, "System32", "icacls.exe")

	steps := [][]string{
		{path, "/inheritance:r"},
		{path, "/grant:r", `*S-1-5-18:(OI)(CI)F`},      // SYSTEM full
		{path, "/grant:r", `*S-1-5-32-544:(OI)(CI)F`},  // BUILTIN\Administrators full
	}
	for _, args := range steps {
		out, err := exec.Command(icaclsExe, args...).CombinedOutput()
		if err != nil {
			return fmt.Errorf("icacls %s: %w (output: %s)", strings.Join(args, " "), err, strings.TrimSpace(string(out)))
		}
	}
	return nil
}
