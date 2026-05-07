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

func Python3() string {
	return pickFirstExisting("python3",
		[]string{"/usr/bin/python3", "/bin/python3", "/usr/local/bin/python3"},
		"python3")
}
