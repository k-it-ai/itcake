//go:build linux

package syspath

import (
	"os"
	"path/filepath"
)

func init() {
	// Linux base-system tools (absolute paths under /usr, /bin, /sbin — SIP equivalent)
	register(toolDef{"journalctl", []string{"/usr/bin/journalctl", "/bin/journalctl"}, "journalctl", false})
	register(toolDef{"sysctl", []string{"/usr/sbin/sysctl", "/sbin/sysctl"}, "sysctl", false})
	register(toolDef{"udevadm", []string{"/usr/bin/udevadm", "/bin/udevadm", "/usr/sbin/udevadm", "/sbin/udevadm"}, "udevadm", false})
	register(toolDef{"lsmod", []string{"/usr/sbin/lsmod", "/sbin/lsmod", "/usr/bin/lsmod", "/bin/lsmod"}, "lsmod", false})
	register(toolDef{"modprobe", []string{"/usr/sbin/modprobe", "/sbin/modprobe"}, "modprobe", false})
	register(toolDef{"systemd-analyze", []string{"/usr/bin/systemd-analyze", "/bin/systemd-analyze"}, "systemd-analyze", false})
	register(toolDef{"systemctl", []string{"/usr/bin/systemctl", "/bin/systemctl"}, "systemctl", false})
	register(toolDef{"uptime", []string{"/usr/bin/uptime", "/bin/uptime"}, "uptime", false})
	register(toolDef{"shutdown", []string{"/sbin/shutdown", "/usr/sbin/shutdown", "/usr/bin/shutdown"}, "shutdown", false})
	register(toolDef{"sudo", []string{"/usr/bin/sudo", "/bin/sudo"}, "sudo", false})
	register(toolDef{"arp", []string{"/usr/sbin/arp", "/sbin/arp", "/usr/bin/arp", "/bin/arp"}, "arp", false})
	register(toolDef{"python3", []string{"/usr/bin/python3", "/bin/python3", "/usr/local/bin/python3"}, "python3", false})
	register(toolDef{"xargs", []string{"/usr/bin/xargs", "/bin/xargs"}, "xargs", false})
	register(toolDef{"ps", []string{"/bin/ps", "/usr/bin/ps"}, "ps", false})
	register(toolDef{"ls", []string{"/bin/ls", "/usr/bin/ls"}, "ls", false})

	// Package managers (Debian/Ubuntu)
	register(toolDef{"apt-get", []string{"/usr/bin/apt-get"}, "apt-get", false})
	register(toolDef{"apt", []string{"/usr/bin/apt"}, "apt", false})
	register(toolDef{"dpkg-query", []string{"/usr/bin/dpkg-query"}, "dpkg-query", false})
	register(toolDef{"dpkg", []string{"/usr/bin/dpkg"}, "dpkg", false})

	// Package managers (RHEL/Fedora)
	register(toolDef{"rpm", []string{"/usr/bin/rpm", "/bin/rpm"}, "rpm", false})
	register(toolDef{"dnf", []string{"/usr/bin/dnf", "/bin/dnf"}, "dnf", false})

	// Package managers (Arch)
	register(toolDef{"pacman", []string{"/usr/bin/pacman", "/bin/pacman"}, "pacman", false})

	// Package managers (Alpine)
	register(toolDef{"apk", []string{"/sbin/apk", "/usr/bin/apk", "/usr/sbin/apk"}, "apk", false})

	// User-installed tools (PATH-hijack inherent) — use LookPath fallback
	register(toolDef{"brew", []string{"/home/linuxbrew/.linuxbrew/bin/brew"}, "brew", true})
	register(toolDef{"npm", []string{"/usr/bin/npm", "/usr/local/bin/npm"}, "npm", true})
	register(toolDef{"pip3", []string{"/usr/bin/pip3", "/usr/local/bin/pip3"}, "pip3", true})
	register(toolDef{"pip", []string{"/usr/bin/pip", "/usr/local/bin/pip"}, "pip", true})

	// Windows/macOS stubs — return fallback (not found on Linux)
	registerStubs()
}

func registerStubs() {
	// macOS
	register(toolDef{"system_profiler", nil, "system_profiler", false})
	register(toolDef{"log", nil, "log", false})
	register(toolDef{"defaults", nil, "defaults", false})
	register(toolDef{"systemsetup", nil, "systemsetup", false})
	register(toolDef{"softwareupdate", nil, "softwareupdate", false})
	register(toolDef{"spctl", nil, "spctl", false})
	register(toolDef{"csrutil", nil, "csrutil", false})
	register(toolDef{"sshd", nil, "sshd", false})
	register(toolDef{"fdesetup", nil, "fdesetup", false})
	register(toolDef{"launchctl", nil, "launchctl", false})
	register(toolDef{"vm_stat", nil, "vm_stat", false})
	register(toolDef{"diskutil", nil, "diskutil", false})
	register(toolDef{"sw_vers", nil, "sw_vers", false})
	register(toolDef{"xattr", nil, "xattr", false})
	register(toolDef{"codesign", nil, "codesign", false})

	// Windows
	register(toolDef{"cmd.exe", nil, "cmd.exe", false})
	register(toolDef{"powershell", nil, "powershell", false})
	register(toolDef{"sc.exe", nil, "sc.exe", false})
	register(toolDef{"reg.exe", nil, "reg.exe", false})

	// Windows package managers
	register(toolDef{"winget", nil, "winget", true})
	register(toolDef{"choco", nil, "choco", true})
	register(toolDef{"scoop", nil, "scoop", true})
}

// Journalctl returns the path to journalctl.
func Journalctl() string { return Get("journalctl") }
func Sysctl() string     { return Get("sysctl") }
func Udevadm() string    { return Get("udevadm") }
func Lsmod() string      { return Get("lsmod") }
func Modprobe() string   { return Get("modprobe") }
func SystemdAnalyze() string { return Get("systemd-analyze") }
func Systemctl() string  { return Get("systemctl") }
func Uptime() string     { return Get("uptime") }
func Shutdown() string   { return Get("shutdown") }
func Sudo() string       { return Get("sudo") }
func Arp() string        { return Get("arp") }
func Python3() string    { return Get("python3") }
func Xargs() string      { return Get("xargs") }
func PS() string         { return Get("ps") }
func LS() string         { return Get("ls") }
func Udevadm() string    { return Get("udevadm") }
func Lsmod() string      { return Get("lsmod") }
func Modprobe() string   { return Get("modprobe") }
func SystemdAnalyze() string { return Get("systemd-analyze") }
func Systemctl() string  { return Get("systemctl") }
func Uptime() string     { return Get("uptime") }
func Shutdown() string   { return Get("shutdown") }
func Sudo() string       { return Get("sudo") }
func Arp() string        { return Get("arp") }
func Python3() string    { return Get("python3") }
func Xargs() string      { return Get("xargs") }
func PS() string         { return Get("ps") }
func LS() string         { return Get("ls") }

// Package managers
func AptGet() string    { return Get("apt-get") }
func Apt() string       { return Get("apt") }
func DpkgQuery() string { return Get("dpkg-query") }
func Dpkg() string      { return Get("dpkg") }
func RpmQuery() string  { return Get("rpm") }
func Dnf() string       { return Get("dnf") }
func Pacman() string    { return Get("pacman") }
func Apk() string       { return Get("apk") }

// User-installed tools
func Brew() string { return GetOrLookPath("brew") }
func Npm() string  { return GetOrLookPath("npm") }
func NPM() string  { return Npm() }
func Pip3() string { return GetOrLookPath("pip3") }
func Pip() string  { return GetOrLookPath("pip") }

// Windows/macOS stubs
func SystemProfiler() string { return Get("system_profiler") }
func Logd() string           { return Get("log") }
func Defaults() string       { return Get("defaults") }
func Systemsetup() string    { return Get("systemsetup") }
func Softwareupdate() string { return Get("softwareupdate") }
func Spctl() string          { return Get("spctl") }
func Csrutil() string        { return Get("csrutil") }
func Sshd() string           { return Get("sshd") }
func Fdesetup() string       { return Get("fdesetup") }
func Launchctl() string      { return Get("launchctl") }
func VMStat() string         { return Get("vm_stat") }
func Diskutil() string       { return Get("diskutil") }
func SwVers() string         { return Get("sw_vers") }
func Xattr() string          { return Get("xattr") }
func Codesign() string       { return Get("codesign") }
func CmdExe() string         { return Get("cmd.exe") }
func PowerShell() string     { return Get("powershell") }
func ScExe() string          { return Get("sc.exe") }
func RegExe() string         { return Get("reg.exe") }
func WingetExe() string      { return GetOrLookPath("winget") }
func Choco() string          { return GetOrLookPath("choco") }
func Scoop() string          { return GetOrLookPath("scoop") }