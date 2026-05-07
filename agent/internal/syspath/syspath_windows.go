//go:build windows

package syspath

import (
	"os"
	"path/filepath"
)

// getSystemRoot mirrors the helper in package config — duplicated here
// to keep this package zero-dep for the agent build graph.
func getSystemRoot() string {
	if v := os.Getenv("SystemRoot"); v != "" {
		return v
	}
	return `C:\Windows`
}

func PowerShell() string {
	return pickFirstExisting("powershell.exe",
		[]string{filepath.Join(getSystemRoot(), "System32", "WindowsPowerShell", "v1.0", "powershell.exe")},
		"powershell.exe")
}

func WMIC() string {
	return pickFirstExisting("wmic",
		[]string{filepath.Join(getSystemRoot(), "System32", "wbem", "wmic.exe")},
		"wmic")
}

func Wevtutil() string {
	return pickFirstExisting("wevtutil",
		[]string{filepath.Join(getSystemRoot(), "System32", "wevtutil.exe")},
		"wevtutil")
}

func NetExe() string {
	return pickFirstExisting("net.exe",
		[]string{filepath.Join(getSystemRoot(), "System32", "net.exe")},
		"net.exe")
}

func Auditpol() string {
	return pickFirstExisting("auditpol.exe",
		[]string{filepath.Join(getSystemRoot(), "System32", "auditpol.exe")},
		"auditpol.exe")
}

// Python3 has no canonical install location on Windows (Python.org installer
// drops it under per-user paths, py.exe lives in System32). We don't pin —
// the unqualified name forces PATH lookup, which is the existing behaviour.
// On Windows the agent runs as LocalSystem with the system PATH so user-
// writable directories aren't typically present in scope.
func Python3() string {
	return pickFirstExisting("python3",
		[]string{filepath.Join(getSystemRoot(), "py.exe")},
		"python3")
}
