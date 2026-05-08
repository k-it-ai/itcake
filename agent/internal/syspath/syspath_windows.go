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

// CmdExe pins to %SystemRoot%\System32\cmd.exe so a writable directory
// earlier on PATH can't substitute a hostile cmd.exe.
func CmdExe() string {
	return pickFirstExisting("cmd.exe",
		[]string{filepath.Join(getSystemRoot(), "System32", "cmd.exe")},
		"cmd.exe")
}

// RegExe pins to %SystemRoot%\System32\reg.exe.
func RegExe() string {
	return pickFirstExisting("reg.exe",
		[]string{filepath.Join(getSystemRoot(), "System32", "reg.exe")},
		"reg.exe")
}

// ScExe pins to %SystemRoot%\System32\sc.exe (SCM service control utility).
func ScExe() string {
	return pickFirstExisting("sc.exe",
		[]string{filepath.Join(getSystemRoot(), "System32", "sc.exe")},
		"sc.exe")
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

// Linux/macOS-only stubs so cross-platform call sites compile on Windows.
// On Windows these are not used in practice; the unqualified fallback
// avoids accidental shell-out via PATH.

func Sysctl() string         { return pickFirstExisting("sysctl", nil, "sysctl") }
func Journalctl() string     { return pickFirstExisting("journalctl", nil, "journalctl") }
func Logd() string           { return pickFirstExisting("log", nil, "log") }
func Defaults() string       { return pickFirstExisting("defaults", nil, "defaults") }
func Systemsetup() string    { return pickFirstExisting("systemsetup", nil, "systemsetup") }
func Spctl() string          { return pickFirstExisting("spctl", nil, "spctl") }
func Csrutil() string        { return pickFirstExisting("csrutil", nil, "csrutil") }
func Sshd() string           { return pickFirstExisting("sshd", nil, "sshd") }
func Fdesetup() string       { return pickFirstExisting("fdesetup", nil, "fdesetup") }
func Launchctl() string      { return pickFirstExisting("launchctl", nil, "launchctl") }
func Udevadm() string        { return pickFirstExisting("udevadm", nil, "udevadm") }
func Lsmod() string          { return pickFirstExisting("lsmod", nil, "lsmod") }
func Modprobe() string       { return pickFirstExisting("modprobe", nil, "modprobe") }
func SystemdAnalyze() string { return pickFirstExisting("systemd-analyze", nil, "systemd-analyze") }
func Systemctl() string      { return pickFirstExisting("systemctl", nil, "systemctl") }
func Uptime() string         { return pickFirstExisting("uptime", nil, "uptime") }
func PS() string             { return pickFirstExisting("ps", nil, "ps") }
func LS() string             { return pickFirstExisting("ls", nil, "ls") }

// Arp on Windows pins to %SystemRoot%\System32\arp.exe.
func Arp() string {
	return pickFirstExisting("arp.exe",
		[]string{filepath.Join(getSystemRoot(), "System32", "arp.exe")},
		"arp")
}

// Shutdown on Windows pins to %SystemRoot%\System32\shutdown.exe. Linux
// callers use this name; on Windows the existing checkin.handleReboot
// already builds the absolute path inline.
func Shutdown() string {
	return pickFirstExisting("shutdown.exe",
		[]string{filepath.Join(getSystemRoot(), "System32", "shutdown.exe")},
		"shutdown")
}

// Sudo is Unix-only; Windows stub for cross-platform compile.
func Sudo() string { return pickFirstExisting("sudo", nil, "sudo") }
func VMStat() string         { return pickFirstExisting("vm_stat", nil, "vm_stat") }
func Diskutil() string       { return pickFirstExisting("diskutil", nil, "diskutil") }
func SwVers() string         { return pickFirstExisting("sw_vers", nil, "sw_vers") }
func Softwareupdate() string { return pickFirstExisting("softwareupdate", nil, "softwareupdate") }
func Xattr() string          { return pickFirstExisting("xattr", nil, "xattr") }
func Codesign() string       { return pickFirstExisting("codesign", nil, "codesign") }
func AptGet() string         { return pickFirstExisting("apt-get", nil, "apt-get") }
func Apt() string            { return pickFirstExisting("apt", nil, "apt") }
func DpkgQuery() string      { return pickFirstExisting("dpkg-query", nil, "dpkg-query") }
func Dpkg() string           { return pickFirstExisting("dpkg", nil, "dpkg") }
func RpmQuery() string       { return pickFirstExisting("rpm", nil, "rpm") }
func Dnf() string            { return pickFirstExisting("dnf", nil, "dnf") }
func Pacman() string         { return pickFirstExisting("pacman", nil, "pacman") }
func Apk() string            { return pickFirstExisting("apk", nil, "apk") }

// Brew on Windows is not officially supported but stub kept for cross-platform
// compile. Falls back to PATH lookup.
func Brew() string {
	return pickFirstExistingOrLookPath("brew", nil, "brew")
}

// Npm under LocalSystem may live in C:\Program Files\nodejs\npm.cmd (LTS
// installer's default machine-wide location). User-installed managers
// can be elsewhere; PATH-hijack defense is fundamentally limited — see
// package docstring.
func Npm() string {
	return pickFirstExistingOrLookPath("npm",
		[]string{
			`C:\Program Files\nodejs\npm.cmd`,
			`C:\Program Files\nodejs\npm`,
			`C:\Program Files (x86)\nodejs\npm.cmd`,
		},
		"npm")
}

// NPM is an alias for Npm.
func NPM() string { return Npm() }

// Pip3 on Windows is typically launched via py.exe -3 -m pip; for direct
// invocation we fall back to PATH lookup. PATH-hijack is fundamental.
func Pip3() string {
	return pickFirstExistingOrLookPath("pip3", nil, "pip3")
}

func Pip() string {
	return pickFirstExistingOrLookPath("pip", nil, "pip")
}

// WingetExe — Microsoft's machine-wide install drops winget.exe under
// %ProgramFiles%\WindowsApps\Microsoft.DesktopAppInstaller_*\winget.exe
// (the path includes a version-suffixed directory). The shim under
// %LocalAppData%\Microsoft\WindowsApps\winget.exe is per-user. We can't
// pin the versioned path reliably, so we fall back to LookPath. PATH-hijack
// for winget is fundamentally limited — see package docstring.
func WingetExe() string {
	return pickFirstExistingOrLookPath("winget", nil, "winget")
}

// Choco — community installer drops choco.exe at the (machine-wide)
// canonical path. Even so, this directory is writable by Administrators
// (and chocolatey upgrade rewrites it), so the at-rest trust on the
// binary is not absolute. PATH-hijack defense is fundamentally limited.
func Choco() string {
	return pickFirstExistingOrLookPath("choco",
		[]string{
			`C:\ProgramData\chocolatey\bin\choco.exe`,
			`C:\ProgramData\chocolatey\choco.exe`,
		},
		"choco")
}

// Scoop is per-user by design (refuses to install machine-wide); the
// shim lives under %USERPROFILE%\scoop\shims. We don't pin a canonical
// path because it varies per-user. PATH-hijack is fundamental for scoop.
func Scoop() string {
	return pickFirstExistingOrLookPath("scoop", nil, "scoop")
}
