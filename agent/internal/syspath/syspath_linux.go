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

// VMStat is macOS-only; on Linux we keep a fallback so cross-platform
// callers compile but a real call would resolve to PATH lookup.
func VMStat() string {
	return pickFirstExisting("vm_stat",
		nil,
		"vm_stat")
}

// Diskutil is macOS-only; Linux stub.
func Diskutil() string {
	return pickFirstExisting("diskutil",
		nil,
		"diskutil")
}

// SwVers is macOS-only; Linux stub.
func SwVers() string {
	return pickFirstExisting("sw_vers",
		nil,
		"sw_vers")
}

// Softwareupdate is macOS-only; Linux stub.
func Softwareupdate() string {
	return pickFirstExisting("softwareupdate",
		nil,
		"softwareupdate")
}

// Launchctl is macOS-only; Linux stub.
func Launchctl() string {
	return pickFirstExisting("launchctl",
		nil,
		"launchctl")
}

// Xattr is macOS-only; Linux stub.
func Xattr() string {
	return pickFirstExisting("xattr",
		nil,
		"xattr")
}

// Codesign is macOS-only; Linux stub.
func Codesign() string {
	return pickFirstExisting("codesign",
		nil,
		"codesign")
}

// CmdExe is Windows-only; Linux stub.
func CmdExe() string {
	return pickFirstExisting("cmd.exe",
		nil,
		"cmd.exe")
}

// PowerShell is Windows-only; Linux stub.
func PowerShell() string {
	return pickFirstExisting("powershell", nil, "powershell")
}

// ScExe is Windows-only; Linux stub.
func ScExe() string {
	return pickFirstExisting("sc.exe", nil, "sc.exe")
}

// RegExe is Windows-only; Linux stub.
func RegExe() string {
	return pickFirstExisting("reg",
		nil,
		"reg")
}

// AptGet pins to /usr/bin/apt-get; on every Debian/Ubuntu the file is
// SUID-equivalent (owned by root in a root-only writable directory).
func AptGet() string {
	return pickFirstExisting("apt-get",
		[]string{"/usr/bin/apt-get"},
		"apt-get")
}

// Apt pins to /usr/bin/apt — used by Apt.IsAvailable() to verify the
// binary exists at a system-protected path before claiming the manager
// is present.
func Apt() string {
	return pickFirstExisting("apt",
		[]string{"/usr/bin/apt"},
		"apt")
}

// DpkgQuery pins to /usr/bin/dpkg-query (Debian's database query tool).
func DpkgQuery() string {
	return pickFirstExisting("dpkg-query",
		[]string{"/usr/bin/dpkg-query"},
		"dpkg-query")
}

// Dpkg pins to /usr/bin/dpkg.
func Dpkg() string {
	return pickFirstExisting("dpkg",
		[]string{"/usr/bin/dpkg"},
		"dpkg")
}

// RpmQuery pins to /usr/bin/rpm (Fedora/RHEL/SUSE).
func RpmQuery() string {
	return pickFirstExisting("rpm",
		[]string{"/usr/bin/rpm", "/bin/rpm"},
		"rpm")
}

// Dnf pins to /usr/bin/dnf (Fedora/RHEL).
func Dnf() string {
	return pickFirstExisting("dnf",
		[]string{"/usr/bin/dnf", "/bin/dnf"},
		"dnf")
}

// Pacman pins to /usr/bin/pacman (Arch).
func Pacman() string {
	return pickFirstExisting("pacman",
		[]string{"/usr/bin/pacman", "/bin/pacman"},
		"pacman")
}

// Apk pins to /sbin/apk (Alpine). Some distros also ship /usr/bin/apk
// as a symlink; we list both.
func Apk() string {
	return pickFirstExisting("apk",
		[]string{"/sbin/apk", "/usr/bin/apk", "/usr/sbin/apk"},
		"apk")
}

// Brew on Linux installs to /home/linuxbrew/.linuxbrew/bin/brew (the
// canonical "linuxbrew" location). User-installed; PATH-hijack is
// fundamental — see package docstring.
func Brew() string {
	return pickFirstExistingOrLookPath("brew",
		[]string{"/home/linuxbrew/.linuxbrew/bin/brew"},
		"brew")
}

// Npm — user-installed; PATH-hijack is fundamental. See package docstring.
func Npm() string {
	return pickFirstExistingOrLookPath("npm",
		[]string{"/usr/bin/npm", "/usr/local/bin/npm"},
		"npm")
}

// NPM is an alias for Npm to satisfy callers that use the Go stdlib's
// canonical capitalisation. Equivalent to Npm().
func NPM() string { return Npm() }

// Pip3 — user-installed; PATH-hijack is fundamental. See package docstring.
func Pip3() string {
	return pickFirstExistingOrLookPath("pip3",
		[]string{"/usr/bin/pip3", "/usr/local/bin/pip3"},
		"pip3")
}

// Pip — fallback for distros without pip3 alias.
func Pip() string {
	return pickFirstExistingOrLookPath("pip",
		[]string{"/usr/bin/pip", "/usr/local/bin/pip"},
		"pip")
}

// WingetExe is Windows-only; Linux stub.
func WingetExe() string {
	return pickFirstExistingOrLookPath("winget",
		nil,
		"winget")
}

// Choco is Windows-only; Linux stub.
func Choco() string {
	return pickFirstExistingOrLookPath("choco",
		nil,
		"choco")
}

// Scoop is Windows-only; Linux stub.
func Scoop() string {
	return pickFirstExistingOrLookPath("scoop",
		nil,
		"scoop")
}
