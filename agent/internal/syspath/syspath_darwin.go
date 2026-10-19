//go:build darwin

package syspath

func init() {
	// macOS base-system tools under SIP-protected /usr/bin and /usr/sbin
	register(toolDef{"system_profiler", []string{"/usr/sbin/system_profiler"}, "system_profiler", false})
	register(toolDef{"log", []string{"/usr/bin/log"}, "log", false})
	register(toolDef{"sysctl", []string{"/usr/sbin/sysctl"}, "sysctl", false})
	register(toolDef{"defaults", []string{"/usr/bin/defaults"}, "defaults", false})
	register(toolDef{"systemsetup", []string{"/usr/sbin/systemsetup"}, "systemsetup", false})
	register(toolDef{"softwareupdate", []string{"/usr/sbin/softwareupdate"}, "softwareupdate", false})
	register(toolDef{"spctl", []string{"/usr/sbin/spctl"}, "spctl", false})
	register(toolDef{"csrutil", []string{"/usr/bin/csrutil"}, "csrutil", false})
	register(toolDef{"sshd", []string{"/usr/sbin/sshd"}, "sshd", false})
	register(toolDef{"fdesetup", []string{"/usr/bin/fdesetup"}, "fdesetup", false})
	register(toolDef{"launchctl", []string{"/bin/launchctl"}, "launchctl", false})
	register(toolDef{"python3", []string{"/usr/bin/python3", "/usr/local/bin/python3"}, "python3", false})
	register(toolDef{"xargs", []string{"/usr/bin/xargs"}, "xargs", false})
	register(toolDef{"ps", []string{"/bin/ps", "/usr/bin/ps"}, "ps", false})
	register(toolDef{"ls", []string{"/bin/ls", "/usr/bin/ls"}, "ls", false})
	register(toolDef{"vm_stat", []string{"/usr/bin/vm_stat"}, "vm_stat", false})
	register(toolDef{"diskutil", []string{"/usr/sbin/diskutil"}, "diskutil", false})
	register(toolDef{"sw_vers", []string{"/usr/bin/sw_vers"}, "sw_vers", false})
	register(toolDef{"xattr", []string{"/usr/bin/xattr"}, "xattr", false})
	register(toolDef{"codesign", []string{"/usr/bin/codesign"}, "codesign", false})
	register(toolDef{"shutdown", []string{"/sbin/shutdown"}, "shutdown", false})
	register(toolDef{"sudo", []string{"/usr/bin/sudo"}, "sudo", false})
	register(toolDef{"arp", []string{"/usr/sbin/arp"}, "arp", false})

	// User-installed tools (PATH-hijack inherent)
	register(toolDef{"brew", []string{"/opt/homebrew/bin/brew", "/usr/local/bin/brew"}, "brew", true})
	register(toolDef{"npm", []string{"/opt/homebrew/bin/npm", "/usr/local/bin/npm", "/usr/bin/npm"}, "npm", true})
	register(toolDef{"pip3", []string{"/opt/homebrew/bin/pip3", "/usr/local/bin/pip3", "/usr/bin/pip3"}, "pip3", true})
	register(toolDef{"pip", []string{"/opt/homebrew/bin/pip", "/usr/local/bin/pip", "/usr/bin/pip"}, "pip", true})

	// Linux/Windows stubs
	registerStubs()
}

func registerStubs() {
	// Linux
	register(toolDef{"journalctl", nil, "journalctl", false})
	register(toolDef{"systemctl", nil, "systemctl", false})
	register(toolDef{"apt-get", nil, "apt-get", false})
	register(toolDef{"apt", nil, "apt", false})
	register(toolDef{"dpkg-query", nil, "dpkg-query", false})
	register(toolDef{"dpkg", nil, "dpkg", false})
	register(toolDef{"rpm", nil, "rpm", false})
	register(toolDef{"dnf", nil, "dnf", false})
	register(toolDef{"pacman", nil, "pacman", false})
	register(toolDef{"apk", nil, "apk", false})

	// Windows
	register(toolDef{"cmd.exe", nil, "cmd.exe", false})
	register(toolDef{"powershell", nil, "powershell", false})
	register(toolDef{"sc.exe", nil, "sc.exe", false})
	register(toolDef{"reg.exe", nil, "reg.exe", false})
	register(toolDef{"winget", nil, "winget", true})
	register(toolDef{"choco", nil, "choco", true})
	register(toolDef{"scoop", nil, "scoop", true})
}

// macOS tools
func SystemProfiler() string { return Get("system_profiler") }
func Logd() string           { return Get("log") }
func Sysctl() string         { return Get("sysctl") }
func Defaults() string       { return Get("defaults") }
func Systemsetup() string    { return Get("systemsetup") }
func Softwareupdate() string { return Get("softwareupdate") }
func Spctl() string          { return Get("spctl") }
func Csrutil() string        { return Get("csrutil") }
func Sshd() string           { return Get("sshd") }
func Fdesetup() string       { return Get("fdesetup") }
func Launchctl() string      { return Get("launchctl") }
func Python3() string        { return Get("python3") }
func Xargs() string          { return Get("xargs") }
func PS() string             { return Get("ps") }
func LS() string             { return Get("ls") }
func VMStat() string         { return Get("vm_stat") }
func Diskutil() string       { return Get("diskutil") }
func SwVers() string         { return Get("sw_vers") }
func Xattr() string          { return Get("xattr") }
func Codesign() string       { return Get("codesign") }
func Shutdown() string       { return Get("shutdown") }
func Sudo() string           { return Get("sudo") }
func Arp() string            { return Get("arp") }

// Linux stubs
func Journalctl() string     { return Get("journalctl") }
func Udevadm() string        { return Get("udevadm") }
func Lsmod() string          { return Get("lsmod") }
func Modprobe() string       { return Get("modprobe") }
func SystemdAnalyze() string { return Get("systemd-analyze") }
func Systemctl() string      { return Get("systemctl") }
func Uptime() string         { return Get("uptime") }

// Windows stubs
func CmdExe() string     { return Get("cmd.exe") }
func PowerShell() string { return Get("powershell") }
func ScExe() string      { return Get("sc.exe") }
func RegExe() string     { return Get("reg.exe") }
func WingetExe() string  { return GetOrLookPath("winget") }
func Choco() string      { return GetOrLookPath("choco") }
func Scoop() string      { return GetOrLookPath("scoop") }

// Linux package-manager tools (stubs on macOS)
func AptGet() string    { return Get("apt-get") }
func Apt() string       { return Get("apt") }
func DpkgQuery() string { return Get("dpkg-query") }
func Dpkg() string      { return Get("dpkg") }
func RpmQuery() string  { return Get("rpm") }
func Dnf() string       { return Get("dnf") }
func Pacman() string    { return Get("pacman") }
func Apk() string       { return Get("apk") }

// Linux user-installed tools (stubs on macOS)
func Brew() string { return GetOrLookPath("brew") }
func Npm() string  { return GetOrLookPath("npm") }
func NPM() string  { return Npm() }
func Pip3() string { return GetOrLookPath("pip3") }
func Pip() string  { return GetOrLookPath("pip") }

// Windows package managers (stubs on macOS)