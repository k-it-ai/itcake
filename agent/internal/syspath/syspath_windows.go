//go:build windows

package syspath

import (
	"os"
	"path/filepath"
)

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

func CmdExe() string {
	return pickFirstExisting("cmd.exe",
		[]string{filepath.Join(getSystemRoot(), "System32", "cmd.exe")},
		"cmd.exe")
}

func RegExe() string {
	return pickFirstExisting("reg.exe",
		[]string{filepath.Join(getSystemRoot(), "System32", "reg.exe")},
		"reg.exe")
}

func ScExe() string {
	return pickFirstExisting("sc.exe",
		[]string{filepath.Join(getSystemRoot(), "System32", "sc.exe")},
		"sc.exe")
}

// Taskkill is used by the Windows executor's Cancel hook to tree-kill
// (/T /F) the spawned process tree when a command's timeout fires.
func Taskkill() string {
	return pickFirstExisting("taskkill.exe",
		[]string{filepath.Join(getSystemRoot(), "System32", "taskkill.exe")},
		"taskkill.exe")
}

func Python3() string {
	return pickFirstExisting("python3",
		[]string{filepath.Join(getSystemRoot(), "py.exe")},
		"python3")
}

func Xargs() string { return pickFirstExisting("xargs", nil, "xargs") }

// Linux/macOS stubs follow for cross-platform compile.

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

func Arp() string {
	return pickFirstExisting("arp.exe",
		[]string{filepath.Join(getSystemRoot(), "System32", "arp.exe")},
		"arp")
}

func Shutdown() string {
	return pickFirstExisting("shutdown.exe",
		[]string{filepath.Join(getSystemRoot(), "System32", "shutdown.exe")},
		"shutdown")
}

func Sudo() string           { return pickFirstExisting("sudo", nil, "sudo") }
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

func Brew() string {
	return pickFirstExistingOrLookPath("brew", nil, "brew")
}

func Npm() string {
	return pickFirstExistingOrLookPath("npm",
		[]string{
			`C:\Program Files\nodejs\npm.cmd`,
			`C:\Program Files\nodejs\npm`,
			`C:\Program Files (x86)\nodejs\npm.cmd`,
		},
		"npm")
}

func NPM() string { return Npm() }

func Pip3() string {
	return pickFirstExistingOrLookPath("pip3", nil, "pip3")
}

func Pip() string {
	return pickFirstExistingOrLookPath("pip", nil, "pip")
}

func WingetExe() string {
	return pickFirstExistingOrLookPath("winget", nil, "winget")
}

func Choco() string {
	return pickFirstExistingOrLookPath("choco",
		[]string{
			`C:\ProgramData\chocolatey\bin\choco.exe`,
			`C:\ProgramData\chocolatey\choco.exe`,
		},
		"choco")
}

func Scoop() string {
	return pickFirstExistingOrLookPath("scoop", nil, "scoop")
}
