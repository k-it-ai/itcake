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
