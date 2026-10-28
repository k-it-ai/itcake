//go:build windows

package config

import (
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"

	"golang.org/x/sys/windows"
)

func systemIcaclsPath() (string, error) {
	sysDir, err := windows.GetSystemDirectory()
	if err != nil || sysDir == "" {
		return "", fmt.Errorf("GetSystemDirectory: %w", err)
	}
	return filepath.Join(sysDir, "icacls.exe"), nil
}

// currentUserSID returns the SID of the account running the agent. The
// interactive `enroll`/`run` commands and the installed service must both be
// able to read the config they wrote; granting only SYSTEM and Administrators
// leaves a non-elevated owner with no access after inheritance is removed.
func currentUserSID() (string, error) {
	token := windows.GetCurrentProcessToken()
	user, err := token.GetTokenUser()
	if err != nil {
		return "", fmt.Errorf("GetTokenUser: %w", err)
	}
	if user.User.Sid == nil {
		return "", fmt.Errorf("GetTokenUser: token has no user SID")
	}
	return user.User.Sid.String(), nil
}

func lockdownPath(path string) error {
	if runtime.GOOS != "windows" {
		return nil
	}
	icaclsExe, err := systemIcaclsPath()
	if err != nil {
		return err
	}
	userSID, err := currentUserSID()
	if err != nil {
		return err
	}
	fi, err := os.Stat(path)
	if err != nil {
		return err
	}
	// icacls silently ignores inheritance flags on a file. Passing
	// `:(OI)(CI)F` for the config file leaves it with an empty DACL after
	// /inheritance:r, which denies access to everyone including its owner.
	perm := ":F"
	if fi.IsDir() {
		perm = ":(OI)(CI)F"
	}

	steps := [][]string{
		{path, "/inheritance:r"},
		{path, "/grant:r", "*" + userSID + perm},
		{path, "/grant:r", `*S-1-5-18` + perm},
		{path, "/grant:r", `*S-1-5-32-544` + perm},
	}
	for _, args := range steps {
		out, err := exec.Command(icaclsExe, args...).CombinedOutput()
		if err != nil {
			return fmt.Errorf("icacls %s: %w (output: %s)", strings.Join(args, " "), err, strings.TrimSpace(string(out)))
		}
	}
	return nil
}
