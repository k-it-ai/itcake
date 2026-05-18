//go:build windows

package config

import (
	"fmt"
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

func lockdownPath(path string) error {
	if runtime.GOOS != "windows" {
		return nil
	}
	icaclsExe, err := systemIcaclsPath()
	if err != nil {
		return err
	}

	steps := [][]string{
		{path, "/inheritance:r"},
		{path, "/grant:r", `*S-1-5-18:(OI)(CI)F`},
		{path, "/grant:r", `*S-1-5-32-544:(OI)(CI)F`},
	}
	for _, args := range steps {
		out, err := exec.Command(icaclsExe, args...).CombinedOutput()
		if err != nil {
			return fmt.Errorf("icacls %s: %w (output: %s)", strings.Join(args, " "), err, strings.TrimSpace(string(out)))
		}
	}
	return nil
}
