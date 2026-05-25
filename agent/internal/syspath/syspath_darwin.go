//go:build darwin

package syspath

// macOS base-system tools live under SIP-protected /usr/bin and /usr/sbin.
// /opt/homebrew and /usr/local are deliberately excluded — they're writable
// by the console user and are exactly the PATH-hijack vector we close here.

func SystemProfiler() string {
	return pickFirstExisting("system_profiler",
		[]string{"/usr/sbin/system_profiler"},
		"system_profiler")
}

func Logd() string {
	return pickFirstExisting("log",
		[]string{"/usr/bin/log"},
		"log")
}

func Sysctl() string {
	return pickFirstExisting("sysctl",
		[]string{"/usr/sbin/sysctl"},
		"sysctl")
}

func Defaults() string {
	return pickFirstExisting("defaults",
		[]string{"/usr/bin/defaults"},
		"defaults")
}

func Systemsetup() string {
	return pickFirstExisting("systemsetup",
		[]string{"/usr/sbin/systemsetup"},
		"systemsetup")
}

func Softwareupdate() string {
	return pickFirstExisting("softwareupdate",
		[]string{"/usr/sbin/softwareupdate"},
		"softwareupdate")
}

func Spctl() string {
	return pickFirstExisting("spctl",
		[]string{"/usr/sbin/spctl"},
		"spctl")
}

func Csrutil() string {
	return pickFirstExisting("csrutil",
		[]string{"/usr/bin/csrutil"},
		"csrutil")
}

func Sshd() string {
	return pickFirstExisting("sshd",
		[]string{"/usr/sbin/sshd"},
		"sshd")
}

func Fdesetup() string {
	return pickFirstExisting("fdesetup",
		[]string{"/usr/bin/fdesetup"},
		"fdesetup")
}

func Launchctl() string {
	return pickFirstExisting("launchctl",
		[]string{"/bin/launchctl"},
		"launchctl")
}

func Python3() string {
	return pickFirstExisting("python3",
		[]string{"/usr/bin/python3", "/usr/local/bin/python3"},
		"python3")
}

func Xargs() string {
	return pickFirstExisting("xargs",
		[]string{"/usr/bin/xargs"},
		"xargs")
}

func PS() string {
	return pickFirstExisting("ps",
		[]string{"/bin/ps", "/usr/bin/ps"},
		"ps")
}

func LS() string {
	return pickFirstExisting("ls",
		[]string{"/bin/ls", "/usr/bin/ls"},
		"ls")
}

func VMStat() string {
	return pickFirstExisting("vm_stat",
		[]string{"/usr/bin/vm_stat"},
		"vm_stat")
}

func Diskutil() string {
	return pickFirstExisting("diskutil",
		[]string{"/usr/sbin/diskutil"},
		"diskutil")
}

func SwVers() string {
	return pickFirstExisting("sw_vers",
		[]string{"/usr/bin/sw_vers"},
		"sw_vers")
}

func Xattr() string {
	return pickFirstExisting("xattr",
		[]string{"/usr/bin/xattr"},
		"xattr")
}

func Codesign() string {
	return pickFirstExisting("codesign",
		[]string{"/usr/bin/codesign"},
		"codesign")
}

func Shutdown() string {
	return pickFirstExisting("shutdown",
		[]string{"/sbin/shutdown"},
		"shutdown")
}

func Sudo() string {
	return pickFirstExisting("sudo",
		[]string{"/usr/bin/sudo"},
		"sudo")
}

func Arp() string {
	return pickFirstExisting("arp",
		[]string{"/usr/sbin/arp"},
		"arp")
}

// Windows-only stubs follow so cross-platform code compiles.

func CmdExe() string     { return pickFirstExisting("cmd.exe", nil, "cmd.exe") }
func PowerShell() string { return pickFirstExisting("powershell", nil, "powershell") }
func ScExe() string      { return pickFirstExisting("sc.exe", nil, "sc.exe") }
func RegExe() string     { return pickFirstExisting("reg", nil, "reg") }

// Linux-only package-manager stubs follow.

func Systemctl() string {
	return pickFirstExisting("systemctl",
		nil,
		"systemctl")
}

func AptGet() string {
	return pickFirstExisting("apt-get",
		nil,
		"apt-get")
}

func Apt() string {
	return pickFirstExisting("apt",
		nil,
		"apt")
}

func DpkgQuery() string {
	return pickFirstExisting("dpkg-query",
		nil,
		"dpkg-query")
}

func Dpkg() string {
	return pickFirstExisting("dpkg",
		nil,
		"dpkg")
}

func RpmQuery() string {
	return pickFirstExisting("rpm",
		nil,
		"rpm")
}

func Dnf() string {
	return pickFirstExisting("dnf",
		nil,
		"dnf")
}

func Pacman() string {
	return pickFirstExisting("pacman",
		nil,
		"pacman")
}

func Apk() string {
	return pickFirstExisting("apk",
		nil,
		"apk")
}

func Brew() string {
	return pickFirstExistingOrLookPath("brew",
		[]string{"/opt/homebrew/bin/brew", "/usr/local/bin/brew"},
		"brew")
}

func Npm() string {
	return pickFirstExistingOrLookPath("npm",
		[]string{"/opt/homebrew/bin/npm", "/usr/local/bin/npm", "/usr/bin/npm"},
		"npm")
}

func NPM() string { return Npm() }

func Pip3() string {
	return pickFirstExistingOrLookPath("pip3",
		[]string{"/opt/homebrew/bin/pip3", "/usr/local/bin/pip3", "/usr/bin/pip3"},
		"pip3")
}

func Pip() string {
	return pickFirstExistingOrLookPath("pip",
		[]string{"/opt/homebrew/bin/pip", "/usr/local/bin/pip", "/usr/bin/pip"},
		"pip")
}

func WingetExe() string { return pickFirstExistingOrLookPath("winget", nil, "winget") }
func Choco() string     { return pickFirstExistingOrLookPath("choco", nil, "choco") }
func Scoop() string     { return pickFirstExistingOrLookPath("scoop", nil, "scoop") }
