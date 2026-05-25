//go:build linux

package syspath

func Journalctl() string {
	return pickFirstExisting("journalctl",
		[]string{"/usr/bin/journalctl", "/bin/journalctl"},
		"journalctl")
}

func Sysctl() string {
	return pickFirstExisting("sysctl",
		[]string{"/usr/sbin/sysctl", "/sbin/sysctl"},
		"sysctl")
}

func Udevadm() string {
	return pickFirstExisting("udevadm",
		[]string{"/usr/bin/udevadm", "/bin/udevadm", "/usr/sbin/udevadm", "/sbin/udevadm"},
		"udevadm")
}

func Lsmod() string {
	return pickFirstExisting("lsmod",
		[]string{"/usr/sbin/lsmod", "/sbin/lsmod", "/usr/bin/lsmod", "/bin/lsmod"},
		"lsmod")
}

func Modprobe() string {
	return pickFirstExisting("modprobe",
		[]string{"/usr/sbin/modprobe", "/sbin/modprobe"},
		"modprobe")
}

func SystemdAnalyze() string {
	return pickFirstExisting("systemd-analyze",
		[]string{"/usr/bin/systemd-analyze", "/bin/systemd-analyze"},
		"systemd-analyze")
}

func Systemctl() string {
	return pickFirstExisting("systemctl",
		[]string{"/usr/bin/systemctl", "/bin/systemctl"},
		"systemctl")
}

func Uptime() string {
	return pickFirstExisting("uptime",
		[]string{"/usr/bin/uptime", "/bin/uptime"},
		"uptime")
}

func Shutdown() string {
	return pickFirstExisting("shutdown",
		[]string{"/sbin/shutdown", "/usr/sbin/shutdown", "/usr/bin/shutdown"},
		"shutdown")
}

func Sudo() string {
	return pickFirstExisting("sudo",
		[]string{"/usr/bin/sudo", "/bin/sudo"},
		"sudo")
}

func Arp() string {
	return pickFirstExisting("arp",
		[]string{"/usr/sbin/arp", "/sbin/arp", "/usr/bin/arp", "/bin/arp"},
		"arp")
}

func Python3() string {
	return pickFirstExisting("python3",
		[]string{"/usr/bin/python3", "/bin/python3", "/usr/local/bin/python3"},
		"python3")
}

func Xargs() string {
	return pickFirstExisting("xargs",
		[]string{"/usr/bin/xargs", "/bin/xargs"},
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

// macOS-only stubs follow.

func VMStat() string         { return pickFirstExisting("vm_stat", nil, "vm_stat") }
func Diskutil() string       { return pickFirstExisting("diskutil", nil, "diskutil") }
func SwVers() string         { return pickFirstExisting("sw_vers", nil, "sw_vers") }
func Softwareupdate() string { return pickFirstExisting("softwareupdate", nil, "softwareupdate") }
func Launchctl() string      { return pickFirstExisting("launchctl", nil, "launchctl") }
func Xattr() string          { return pickFirstExisting("xattr", nil, "xattr") }
func Codesign() string       { return pickFirstExisting("codesign", nil, "codesign") }

// Windows-only stubs follow.

func CmdExe() string     { return pickFirstExisting("cmd.exe", nil, "cmd.exe") }
func PowerShell() string { return pickFirstExisting("powershell", nil, "powershell") }
func ScExe() string      { return pickFirstExisting("sc.exe", nil, "sc.exe") }
func RegExe() string     { return pickFirstExisting("reg", nil, "reg") }

func AptGet() string {
	return pickFirstExisting("apt-get",
		[]string{"/usr/bin/apt-get"},
		"apt-get")
}

func Apt() string {
	return pickFirstExisting("apt",
		[]string{"/usr/bin/apt"},
		"apt")
}

func DpkgQuery() string {
	return pickFirstExisting("dpkg-query",
		[]string{"/usr/bin/dpkg-query"},
		"dpkg-query")
}

func Dpkg() string {
	return pickFirstExisting("dpkg",
		[]string{"/usr/bin/dpkg"},
		"dpkg")
}

func RpmQuery() string {
	return pickFirstExisting("rpm",
		[]string{"/usr/bin/rpm", "/bin/rpm"},
		"rpm")
}

func Dnf() string {
	return pickFirstExisting("dnf",
		[]string{"/usr/bin/dnf", "/bin/dnf"},
		"dnf")
}

func Pacman() string {
	return pickFirstExisting("pacman",
		[]string{"/usr/bin/pacman", "/bin/pacman"},
		"pacman")
}

func Apk() string {
	return pickFirstExisting("apk",
		[]string{"/sbin/apk", "/usr/bin/apk", "/usr/sbin/apk"},
		"apk")
}

func Brew() string {
	return pickFirstExistingOrLookPath("brew",
		[]string{"/home/linuxbrew/.linuxbrew/bin/brew"},
		"brew")
}

func Npm() string {
	return pickFirstExistingOrLookPath("npm",
		[]string{"/usr/bin/npm", "/usr/local/bin/npm"},
		"npm")
}

func NPM() string { return Npm() }

func Pip3() string {
	return pickFirstExistingOrLookPath("pip3",
		[]string{"/usr/bin/pip3", "/usr/local/bin/pip3"},
		"pip3")
}

func Pip() string {
	return pickFirstExistingOrLookPath("pip",
		[]string{"/usr/bin/pip", "/usr/local/bin/pip"},
		"pip")
}

func WingetExe() string { return pickFirstExistingOrLookPath("winget", nil, "winget") }
func Choco() string     { return pickFirstExistingOrLookPath("choco", nil, "choco") }
func Scoop() string     { return pickFirstExistingOrLookPath("scoop", nil, "scoop") }
