//go:build windows

package config

import (
	"fmt"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
)

// lockdownPath strips inherited ACEs and grants only SYSTEM and the
// local Administrators group on `path`. Without this, the default
// inheritance from C:\ProgramData lets Authenticated Users READ the
// agent-config.json — and since MachineGuid (HKLM\SOFTWARE\Microsoft\
// Cryptography) is world-readable plus the HKDF salt sits inside the
// config, any non-admin local user can re-derive the key and recover
// the bearer token + per-agent HMAC secret. Linux gets this via
// 0o700/0o600 file modes; on Windows, Go silently ignores those, so
// we have to do it explicitly.
//
// We shell out to icacls because (a) it's universally available on
// every supported Windows SKU, (b) the alternative is a substantial
// SDDL/ACL dance through golang.org/x/sys/windows that triples the
// surface area, and (c) failing to harden is a security regression
// — we'd rather a clear icacls error than a half-applied ACL.
//
// The %SystemRoot%\System32\icacls.exe absolute path defends against
// PATH hijack — same defense as readMachineID's reg.exe call.
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
