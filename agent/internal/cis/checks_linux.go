//go:build linux

package cis

import (
	"context"
	"os"
	"os/exec"
	"strings"

	"github.com/itcake/agent/internal/syspath"
)

func platformName() string { return "linux" }

func platformChecks() []Check {
	return []Check{
		{ID: "1.1.1.1", Title: "cramfs filesystem disabled", Severity: SeverityLow, Fn: checkLinuxModuleDisabled("cramfs")},
		{ID: "1.1.1.2", Title: "squashfs filesystem disabled", Severity: SeverityLow, Fn: checkLinuxModuleDisabled("squashfs")},
		{ID: "1.1.1.3", Title: "udf filesystem disabled", Severity: SeverityLow, Fn: checkLinuxModuleDisabled("udf")},
		{ID: "1.4.1", Title: "Core dumps restricted (fs.suid_dumpable = 0)", Severity: SeverityMedium, Fn: checkLinuxSysctl("fs.suid_dumpable", "0")},
		{ID: "1.5.3", Title: "ASLR enabled (kernel.randomize_va_space = 2)", Severity: SeverityHigh, Fn: checkLinuxSysctl("kernel.randomize_va_space", "2")},
		{ID: "1.5.4", Title: "Prelink not installed", Severity: SeverityLow, Fn: checkLinuxNoPrelink},
		{ID: "3.2.1", Title: "Source-routed packets not accepted (net.ipv4.conf.all.accept_source_route = 0)", Severity: SeverityMedium, Fn: checkLinuxSysctl("net.ipv4.conf.all.accept_source_route", "0")},
		{ID: "3.2.2", Title: "ICMP redirects not accepted (net.ipv4.conf.all.accept_redirects = 0)", Severity: SeverityMedium, Fn: checkLinuxSysctl("net.ipv4.conf.all.accept_redirects", "0")},
		{ID: "3.2.3", Title: "Secure ICMP redirects not accepted (net.ipv4.conf.all.secure_redirects = 0)", Severity: SeverityMedium, Fn: checkLinuxSysctl("net.ipv4.conf.all.secure_redirects", "0")},
		{ID: "3.2.4", Title: "Suspicious packets logged (net.ipv4.conf.all.log_martians = 1)", Severity: SeverityLow, Fn: checkLinuxSysctl("net.ipv4.conf.all.log_martians", "1")},
		{ID: "3.2.7", Title: "Reverse path filtering enabled (net.ipv4.conf.all.rp_filter = 1)", Severity: SeverityMedium, Fn: checkLinuxSysctl("net.ipv4.conf.all.rp_filter", "1")},
		{ID: "3.3.1", Title: "IP forwarding disabled (net.ipv4.ip_forward = 0)", Severity: SeverityMedium, Fn: checkLinuxSysctl("net.ipv4.ip_forward", "0")},
		{ID: "3.4.1", Title: "Host firewall active", Severity: SeverityHigh, Fn: checkLinuxFirewall},
		{ID: "5.2.1", Title: "/etc/ssh/sshd_config permissions ≤ 0600", Severity: SeverityHigh, Fn: checkLinuxSshdConfigMode},
		{ID: "5.2.4", Title: "SSH MaxAuthTries ≤ 4", Severity: SeverityMedium, Fn: checkLinuxSSHIntKey("maxauthtries", 4, false)},
		{ID: "5.2.5", Title: "SSH PermitRootLogin = no", Severity: SeverityHigh, Fn: checkLinuxSSHKeyEquals("permitrootlogin", "no")},
		{ID: "5.2.6", Title: "SSH PermitEmptyPasswords = no", Severity: SeverityHigh, Fn: checkLinuxSSHKeyEquals("permitemptypasswords", "no")},
		{ID: "5.2.7", Title: "SSH IgnoreRhosts = yes", Severity: SeverityHigh, Fn: checkLinuxSSHKeyEquals("ignorerhosts", "yes")},
		{ID: "5.2.10", Title: "SSH ClientAliveInterval ≤ 300s", Severity: SeverityLow, Fn: checkLinuxSSHIntKey("clientaliveinterval", 300, false)},
		{ID: "5.2.13", Title: "SSH LoginGraceTime ≤ 60s", Severity: SeverityMedium, Fn: checkLinuxSSHLoginGraceTime},
		{ID: "5.4.1", Title: "Password hashing uses SHA512 or YESCRYPT", Severity: SeverityHigh, Fn: checkLinuxLoginDefsEncryptMethod},
		{ID: "6.1.2", Title: "/etc/passwd permissions ≤ 0644", Severity: SeverityMedium, Fn: checkLinuxFileMode("/etc/passwd", 0o644)},
		{ID: "6.1.3", Title: "/etc/shadow permissions ≤ 0640", Severity: SeverityHigh, Fn: checkLinuxFileMode("/etc/shadow", 0o640)},
	}
}

func checkLinuxModuleDisabled(name string) func(context.Context) CheckResult {
	return func(ctx context.Context) CheckResult {
		out, err := exec.CommandContext(ctx, syspath.Modprobe(), "-n", "-v", name).Output()
		if err != nil {
			return CheckResult{Status: StatusError, Message: "modprobe not available: " + err.Error()}
		}
		body := strings.ToLower(string(out))
		disabled := strings.Contains(body, "install /bin/true") || strings.Contains(body, "install /bin/false")
		if !disabled {
			return CheckResult{Status: StatusFail, Message: name + " not blacklisted via modprobe.d", Evidence: strings.TrimSpace(string(out))}
		}
		if loaded, _ := isLinuxModuleLoaded(ctx, name); loaded {
			return CheckResult{Status: StatusFail, Message: name + " module is loaded", Evidence: "lsmod | grep " + name}
		}
		return CheckResult{Status: StatusPass, Evidence: strings.TrimSpace(string(out))}
	}
}

func isLinuxModuleLoaded(ctx context.Context, name string) (bool, error) {
	out, err := exec.CommandContext(ctx, syspath.Lsmod()).Output()
	if err != nil {
		return false, err
	}
	for _, line := range strings.Split(string(out), "\n") {
		fields := strings.Fields(line)
		if len(fields) > 0 && fields[0] == name {
			return true, nil
		}
	}
	return false, nil
}

func checkLinuxSysctl(key, want string) func(context.Context) CheckResult {
	return func(ctx context.Context) CheckResult {
		out, err := exec.CommandContext(ctx, syspath.Sysctl(), "-n", key).Output()
		if err != nil {
			return CheckResult{Status: StatusError, Message: "sysctl unavailable: " + err.Error()}
		}
		got := strings.TrimSpace(string(out))
		if got != want {
			return CheckResult{Status: StatusFail, Message: key + " = " + got + " (want " + want + ")", Evidence: got}
		}
		return CheckResult{Status: StatusPass, Evidence: key + " = " + got}
	}
}

func checkLinuxNoPrelink(ctx context.Context) CheckResult {
	if _, err := exec.LookPath("prelink"); err == nil {
		return CheckResult{Status: StatusFail, Message: "prelink binary present in PATH"}
	}
	return CheckResult{Status: StatusPass}
}

func checkLinuxFirewall(ctx context.Context) CheckResult {
	// Absolute paths defend against PATH-hijack of ufw/iptables/etc.
	candidates := []struct {
		paths []string
		args  []string
		look  string
		label string
	}{
		{[]string{"/usr/sbin/ufw", "/sbin/ufw", "/usr/bin/ufw"}, []string{"status"}, "active", "ufw"},
		{[]string{"/usr/bin/firewall-cmd", "/usr/sbin/firewall-cmd"}, []string{"--state"}, "running", "firewalld"},
		{[]string{"/usr/sbin/nft", "/sbin/nft", "/usr/bin/nft"}, []string{"list", "ruleset"}, "table", "nftables"},
		{[]string{"/usr/sbin/iptables", "/sbin/iptables", "/usr/bin/iptables"}, []string{"-L", "-n"}, "drop", "iptables"},
	}
	for _, c := range candidates {
		path := pickFirstAbsolute(c.paths)
		if path == "" {
			continue
		}
		out, err := exec.CommandContext(ctx, path, c.args...).Output()
		if err != nil {
			continue
		}
		body := strings.ToLower(string(out))
		if strings.Contains(body, c.look) {
			return CheckResult{Status: StatusPass, Evidence: c.label + " active"}
		}
	}
	return CheckResult{Status: StatusFail, Message: "no active firewall (ufw/firewalld/nftables/iptables) detected"}
}

func pickFirstAbsolute(paths []string) string {
	for _, p := range paths {
		if _, err := os.Stat(p); err == nil {
			return p
		}
	}
	return ""
}

func checkLinuxSshdConfigMode(_ context.Context) CheckResult {
	info, err := os.Stat("/etc/ssh/sshd_config")
	if err != nil {
		return CheckResult{Status: StatusNotApplicable, Message: "/etc/ssh/sshd_config not present"}
	}
	mode := info.Mode().Perm()
	if mode > 0o600 {
		return CheckResult{Status: StatusFail, Message: "permissions too permissive", Evidence: mode.String()}
	}
	return CheckResult{Status: StatusPass, Evidence: mode.String()}
}

func readSshdConfig() (string, error) {
	body, err := os.ReadFile("/etc/ssh/sshd_config")
	if err != nil {
		return "", err
	}
	return string(body), nil
}

// checkLinuxSSHKeyEquals passes when sshd_config's active value matches want.
func checkLinuxSSHKeyEquals(key, want string) func(context.Context) CheckResult {
	return func(_ context.Context) CheckResult {
		body, err := readSshdConfig()
		if err != nil {
			return CheckResult{Status: StatusNotApplicable, Message: "sshd_config not readable"}
		}
		got := sshdConfigValue(body, key)
		if got == "" {
			return CheckResult{Status: StatusFail, Message: key + " not set", Evidence: "default applies"}
		}
		if !strings.EqualFold(got, want) {
			return CheckResult{Status: StatusFail, Message: key + " = " + got + " (want " + want + ")", Evidence: got}
		}
		return CheckResult{Status: StatusPass, Evidence: key + " = " + got}
	}
}

func checkLinuxSSHLoginGraceTime(_ context.Context) CheckResult {
	body, err := readSshdConfig()
	if err != nil {
		return CheckResult{Status: StatusNotApplicable, Message: "sshd_config not readable"}
	}
	got := sshdConfigValue(body, "logingracetime")
	if got == "" {
		// OpenSSH default is 120s — fails CIS.
		return CheckResult{Status: StatusFail, Message: "LoginGraceTime not set (default 120s)"}
	}
	seconds := parseSshTime(got)
	if seconds <= 0 {
		return CheckResult{Status: StatusError, Message: "unparseable LoginGraceTime: " + got}
	}
	if seconds > 60 {
		return CheckResult{Status: StatusFail, Message: "LoginGraceTime > 60s", Evidence: got}
	}
	return CheckResult{Status: StatusPass, Evidence: got}
}

// parseSshTime understands sshd_config(5) TIME format ("60", "60s", "1m", "1h").
func parseSshTime(s string) int {
	s = strings.TrimSpace(s)
	if s == "" {
		return -1
	}
	n, mult := 0, 0
	for i := 0; i < len(s); i++ {
		c := s[i]
		if c >= '0' && c <= '9' {
			n = n*10 + int(c-'0')
		} else {
			switch c {
			case 's', 'S':
				mult = 1
			case 'm', 'M':
				mult = 60
			case 'h', 'H':
				mult = 3600
			default:
				return -1
			}
			break
		}
	}
	if mult == 0 {
		mult = 1
	}
	return n * mult
}

// sshdConfigValue returns the last-set uncommented value for key. Differs
// from sshd's first-match-wins so admin overrides of packaged defaults win.
func sshdConfigValue(body, keyLower string) string {
	keyLower = strings.ToLower(keyLower)
	out := ""
	for _, line := range strings.Split(body, "\n") {
		s := strings.TrimSpace(line)
		if s == "" || strings.HasPrefix(s, "#") {
			continue
		}
		// strip inline comments
		if hashIdx := strings.Index(s, "#"); hashIdx > 0 {
			s = strings.TrimSpace(s[:hashIdx])
		}
		fields := strings.Fields(s)
		if len(fields) < 2 {
			continue
		}
		if strings.ToLower(fields[0]) != keyLower {
			continue
		}
		out = strings.Join(fields[1:], " ")
	}
	return out
}

func checkLinuxSSHIntKey(key string, threshold int, allowGreater bool) func(context.Context) CheckResult {
	return func(_ context.Context) CheckResult {
		body, err := readSshdConfig()
		if err != nil {
			return CheckResult{Status: StatusNotApplicable, Message: "sshd_config not readable"}
		}
		got := sshdConfigValue(body, key)
		if got == "" {
			return CheckResult{Status: StatusFail, Message: key + " not set", Evidence: "default applies"}
		}
		fields := strings.Fields(got)
		if len(fields) == 0 {
			return CheckResult{Status: StatusError, Message: "empty value for " + key}
		}
		n := 0
		for i := 0; i < len(fields[0]); i++ {
			c := fields[0][i]
			if c < '0' || c > '9' {
				return CheckResult{Status: StatusError, Message: key + " value not numeric: " + got}
			}
			n = n*10 + int(c-'0')
		}
		ok := n <= threshold
		if allowGreater {
			ok = n >= threshold
		}
		if !ok {
			return CheckResult{Status: StatusFail, Message: key + " = " + got + " (want ≤ " + intToString(threshold) + ")", Evidence: got}
		}
		return CheckResult{Status: StatusPass, Evidence: key + " = " + got}
	}
}

func intToString(n int) string {
	if n == 0 {
		return "0"
	}
	neg := false
	if n < 0 {
		neg = true
		n = -n
	}
	digits := []byte{}
	for n > 0 {
		digits = append([]byte{byte('0' + n%10)}, digits...)
		n /= 10
	}
	if neg {
		return "-" + string(digits)
	}
	return string(digits)
}

func checkLinuxFileMode(p string, maxMode os.FileMode) func(context.Context) CheckResult {
	return func(_ context.Context) CheckResult {
		info, err := os.Stat(p)
		if err != nil {
			return CheckResult{Status: StatusNotApplicable, Message: p + " not present"}
		}
		mode := info.Mode().Perm()
		if mode > maxMode {
			return CheckResult{Status: StatusFail, Message: "permissions too permissive", Evidence: mode.String()}
		}
		return CheckResult{Status: StatusPass, Evidence: mode.String()}
	}
}

func checkLinuxLoginDefsEncryptMethod(_ context.Context) CheckResult {
	body, err := os.ReadFile("/etc/login.defs")
	if err != nil {
		return CheckResult{Status: StatusNotApplicable, Message: "/etc/login.defs not readable"}
	}
	for _, line := range strings.Split(string(body), "\n") {
		s := strings.TrimSpace(line)
		if s == "" || strings.HasPrefix(s, "#") {
			continue
		}
		fields := strings.Fields(s)
		if len(fields) < 2 || !strings.EqualFold(fields[0], "ENCRYPT_METHOD") {
			continue
		}
		v := strings.ToUpper(fields[1])
		if v == "SHA512" || v == "YESCRYPT" {
			return CheckResult{Status: StatusPass, Evidence: "ENCRYPT_METHOD = " + v}
		}
		return CheckResult{Status: StatusFail, Message: "weak ENCRYPT_METHOD = " + v, Evidence: v}
	}
	return CheckResult{Status: StatusFail, Message: "ENCRYPT_METHOD not set in /etc/login.defs"}
}
