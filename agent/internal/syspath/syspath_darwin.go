//go:build darwin

package syspath

// macOS base-system tools live under /usr/bin and /usr/sbin. These
// directories are protected by SIP, so an unprivileged user cannot
// substitute the binaries — pinning here closes the homebrew/PATH
// hijack vector. /opt/homebrew and /usr/local are deliberately NOT
// candidates (homebrew is owned by the console user on Apple Silicon
// and is exactly the directory we're trying to defeat).

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

// CmdExe is Windows-only; macOS stub.
func CmdExe() string {
	return pickFirstExisting("cmd.exe",
		nil,
		"cmd.exe")
}

// RegExe is Windows-only; macOS stub.
func RegExe() string {
	return pickFirstExisting("reg",
		nil,
		"reg")
}

// Linux-only package-manager stubs so cross-platform code compiles on
// macOS. Each returns the unqualified fallback because there's no
// system-protected canonical path on macOS for these.
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

// Brew on macOS lives in /opt/homebrew/bin (Apple Silicon) or
// /usr/local/bin (Intel). User-installed by design — these locations
// are writable by the console user. PATH-hijack defense is fundamentally
// limited; see package docstring.
func Brew() string {
	return pickFirstExistingOrLookPath("brew",
		[]string{"/opt/homebrew/bin/brew", "/usr/local/bin/brew"},
		"brew")
}

// Npm — user-installed; PATH-hijack is fundamental. See package docstring.
func Npm() string {
	return pickFirstExistingOrLookPath("npm",
		[]string{"/opt/homebrew/bin/npm", "/usr/local/bin/npm", "/usr/bin/npm"},
		"npm")
}

// NPM is an alias for Npm.
func NPM() string { return Npm() }

// Pip3 — user-installed; PATH-hijack is fundamental.
func Pip3() string {
	return pickFirstExistingOrLookPath("pip3",
		[]string{"/opt/homebrew/bin/pip3", "/usr/local/bin/pip3", "/usr/bin/pip3"},
		"pip3")
}

// Pip — fallback when pip3 isn't present.
func Pip() string {
	return pickFirstExistingOrLookPath("pip",
		[]string{"/opt/homebrew/bin/pip", "/usr/local/bin/pip", "/usr/bin/pip"},
		"pip")
}

// WingetExe is Windows-only; macOS stub.
func WingetExe() string {
	return pickFirstExistingOrLookPath("winget",
		nil,
		"winget")
}

// Choco is Windows-only; macOS stub.
func Choco() string {
	return pickFirstExistingOrLookPath("choco",
		nil,
		"choco")
}

// Scoop is Windows-only; macOS stub.
func Scoop() string {
	return pickFirstExistingOrLookPath("scoop",
		nil,
		"scoop")
}
