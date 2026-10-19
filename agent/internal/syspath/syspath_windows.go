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

func sysPath(elem ...string) string {
	return filepath.Join(getSystemRoot(), filepath.Join(elem...))
}

func init() {
	// Windows system tools
	register(toolDef{"powershell.exe", []string{sysPath("System32", "WindowsPowerShell", "v1.0", "powershell.exe")}, "powershell.exe", false})
	register(toolDef{"wmic", []string{sysPath("System32", "wbem", "wmic.exe")}, "wmic", false})
	register(toolDef{"wevtutil", []string{sysPath("System32", "wevtutil.exe")}, "wevtutil", false})
	register(toolDef{"net.exe", []string{sysPath("System32", "net.exe")}, "net.exe", false})
	register(toolDef{"auditpol.exe", []string{sysPath("System32", "auditpol.exe")}, "auditpol.exe", false})
	register(toolDef{"cmd.exe", []string{sysPath("System32", "cmd.exe")}, "cmd.exe", false})
	register(toolDef{"reg.exe", []string{sysPath("System32", "reg.exe")}, "reg.exe", false})
	register(toolDef{"sc.exe", []string{sysPath("System32", "sc.exe")}, "sc.exe", false})
	register(toolDef{"taskkill.exe", []string{sysPath("System32", "taskkill.exe")}, "taskkill.exe", false})
	register(toolDef{"python3", []string{sysPath("py.exe")}, "python3", false})
	register(toolDef{"xargs", nil, "xargs", false})
	register(toolDef{"arp.exe", []string{sysPath("System32", "arp.exe")}, "arp", false})
	register(toolDef{"shutdown.exe", []string{sysPath("System32", "shutdown.exe")}, "shutdown", false})

	// User-installed tools
	register(toolDef{"npm", []string{
		`C:\Program Files\nodejs\npm.cmd`,
		`C:\Program Files\nodejs\npm`,
		`C:\Program Files (x86)\nodejs\npm.cmd`,
	}, "npm", true})
	register(toolDef{"pip3", nil, "pip3", true})
	register(toolDef{"pip", nil, "pip", true})
	register(toolDef{"winget", nil, "winget", true})
	register(toolDef{"choco", []string{
		`C:\ProgramData\chocolatey\bin\choco.exe`,
		`C:\ProgramData\chocolatey\choco.exe`,
	}, "choco", true})
	register(toolDef{"scoop", nil, "scoop", true})

	// Linux/macOS stubs
	registerStubs()
}

func registerStubs() {
	// Linux
	register(toolDef{"sysctl", nil, "sysctl", false})
	register(toolDef{"journalctl", nil, "journalctl", false})
	register(toolDef{"log", nil, "log", false})
	register(toolDef{"defaults", nil, "defaults", false})
	register(toolDef{"systemsetup", nil, "systemsetup", false})
	register(toolDef{"spctl", nil, "spctl", false})
	register(toolDef{"csrutil", nil, "csrutil", false})
	register(toolDef{"sshd", nil, "sshd", false})
	register(toolDef{"fdesetup", nil, "fdesetup", false})
	register(toolDef{"launchctl", nil, "launchctl", false})
	register(toolDef{"udevadm", nil, "udevadm", false})
	register(toolDef{"lsmod", nil, "lsmod", false})
	register(toolDef{"modprobe", nil, "modprobe", false})
	register(toolDef{"systemd-analyze", nil, "systemd-analyze", false})
	register(toolDef{"systemctl", nil, "systemctl", false})
	register(toolDef{"uptime", nil, "uptime", false})
	register(toolDef{"ps", nil, "ps", false})
	register(toolDef{"ls", nil, "ls", false})
	register(toolDef{"apt-get", nil, "apt-get", false})
	register(toolDef{"apt", nil, "apt", false})
	register(toolDef{"dpkg-query", nil, "dpkg-query", false})
	register(toolDef{"dpkg", nil, "dpkg", false})
	register(toolDef{"rpm", nil, "rpm", false})
	register(toolDef{"dnf", nil, "dnf", false})
	register(toolDef{"pacman", nil, "pacman", false})
	register(toolDef{"apk", nil, "apk", false})

	// macOS
	register(toolDef{"system_profiler", nil, "system_profiler", false})
	register(toolDef{"log", nil, "log", false})
	register(toolDef{"systemsetup", nil, "systemsetup", false})
	register(toolDef{"softwareupdate", nil, "softwareupdate", false})
	register(toolDef{"spctl", nil, "spctl", false})
	register(toolDef{"csrutil", nil, "csrutil", false})
	register(toolDef{"sshd", nil, "sshd", false})
	register(toolDef{"fdesetup", nil, "fdesetup", false})
	register(toolDef{"vm_stat", nil, "vm_stat", false})
	register(toolDef{"diskutil", nil, "diskutil", false})
	register(toolDef{"sw_vers", nil, "sw_vers", false})
	register(toolDef{"xattr", nil, "xattr", false})
	register(toolDef{"codesign", nil, "codesign", false})
	register(toolDef{"brew", nil, "brew", true})
}

// Windows tools
func PowerShell() string { return Get("powershell.exe") }
func WMIC() string      { return Get("wmic") }
func Wevtutil() string  { return Get("wevtutil") }
func NetExe() string    { return Get("net.exe") }
func Auditpol() string  { return Get("auditpol.exe") }
func CmdExe() string    { return Get("cmd.exe") }
func RegExe() string    { return Get("reg.exe") }
func ScExe() string     { return Get("sc.exe") }
func Taskkill() string  { return Get("taskkill.exe") }
func Python3() string   { return Get("python3") }
func Xargs() string     { return Get("xargs") }
func NetExe() string    { return Get("net.exe") }
func Arp() string       { return Get("arp.exe") }
func Shutdown() string  { return Get("shutdown.exe") }
func Sudo() string      { return Get("sudo") }
func Taskkill() string  { return Get("taskkill.exe") }

// Linux/macOS stubs
func Sysctl() string         { return Get("sysctl") }
func Journalctl() string     { return Get("journalctl") }
func Logd() string           { return Get("log") }
func Defaults() string       { return Get("defaults") }
func Systemsetup() string    { return Get("systemsetup") }
func Spctl() string          { return Get("spctl") }
func Csrutil() string        { return Get("csrutil") }
func Sshd() string           { return Get("sshd") }
func Fdesetup() string       { return Get("fdesetup") }
func Launchctl() string      { return Get("launchctl") }
func Udevadm() string        { return Get("udevadm") }
func Lsmod() string          { return Get("lsmod") }
func Modprobe() string       { return Get("modprobe") }
func SystemdAnalyze() string { return Get("systemd-analyze") }
func Systemctl() string      { return Get("systemctl") }
func Uptime() string         { return Get("uptime") }
func PS() string             { return Get("ps") }
func LS() string             { return Get("ls") }
func VMStat() string         { return Get("vm_stat") }
func Diskutil() string       { return Get("diskutil") }
func SwVers() string         { return Get("sw_vers") }
func Softwareupdate() string { return Get("softwareupdate") }
func Xattr() string          { return Get("xattr") }
func Codesign() string       { return Get("codesign") }
func AptGet() string         { return Get("apt-get") }
func Apt() string            { return Get("apt") }
func DpkgQuery() string      { return Get("dpkg-query") }
func Dpkg() string           { return Get("dpkg") }
func RpmQuery() string       { return Get("rpm") }
func Dnf() string            { return Get("dnf") }
func Pacman() string         { return Get("pacman") }
func Apk() string            { return Get("apk") }
func Brew() string           { return GetOrLookPath("brew") }
func Npm() string            { return GetOrLookPath("npm") }
func NPM() string            { return Npm() }
func Pip3() string           { return GetOrLookPath("pip3") }
func Pip() string            { return GetOrLookPath("pip") }
func WingetExe() string      { return GetOrLookPath("winget") }
func Choco() string          { return GetOrLookPath("choco") }
func Scoop() string          { return GetOrLookPath("scoop") }