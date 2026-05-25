//go:build darwin

package cis

import (
	"context"
	"os"
	"os/exec"
	"strings"

	"github.com/itcake/agent/internal/syspath"
)

func platformName() string { return "darwin" }

func platformChecks() []Check {
	return []Check{
		{ID: "1.2", Title: "Software Update auto-check enabled", Severity: SeverityMedium, Fn: checkDarwinDefaults("/Library/Preferences/com.apple.SoftwareUpdate", "AutomaticCheckEnabled", "1")},
		{ID: "1.5", Title: "Critical security updates auto-installed", Severity: SeverityHigh, Fn: checkDarwinDefaults("/Library/Preferences/com.apple.SoftwareUpdate", "CriticalUpdateInstall", "1")},
		{ID: "2.2.1", Title: "FileVault enabled", Severity: SeverityHigh, Fn: checkDarwinFileVault},
		{ID: "2.2.2", Title: "Network time set automatically", Severity: SeverityLow, Fn: checkDarwinNetworkTime},
		{ID: "2.4.1", Title: "Remote Apple Events disabled", Severity: SeverityMedium, Fn: checkDarwinRemoteAppleEvents},
		{ID: "2.4.2", Title: "Internet Sharing disabled", Severity: SeverityHigh, Fn: checkDarwinLaunchdDisabled("com.apple.InternetSharing")},
		{ID: "2.4.3", Title: "Screen Sharing disabled", Severity: SeverityHigh, Fn: checkDarwinLaunchdDisabled("com.apple.screensharing")},
		{ID: "2.4.4", Title: "Printer Sharing disabled", Severity: SeverityMedium, Fn: checkDarwinLaunchdDisabled("org.cups.cups-lpd")},
		{ID: "2.4.7", Title: "NFS Server disabled", Severity: SeverityMedium, Fn: checkDarwinLaunchdDisabled("com.apple.nfsd")},
		{ID: "2.4.8", Title: "File Sharing (SMB) disabled", Severity: SeverityMedium, Fn: checkDarwinLaunchdDisabled("com.apple.smbd")},
		{ID: "2.5.1", Title: "Gatekeeper enabled", Severity: SeverityHigh, Fn: checkDarwinGatekeeper},
		{ID: "5.1.1", Title: "Application firewall enabled", Severity: SeverityHigh, Fn: checkDarwinDefaultsInt("/Library/Preferences/com.apple.alf", "globalstate", []string{"1", "2"})},
		{ID: "5.1.2", Title: "System Integrity Protection enabled", Severity: SeverityHigh, Fn: checkDarwinSIP},
		{ID: "5.1.4", Title: "/var/log permissions ≤ 0755", Severity: SeverityLow, Fn: checkDarwinPathMode("/var/log", 0o755)},
		{ID: "5.2.1", Title: "SSH PermitRootLogin = no", Severity: SeverityHigh, Fn: checkDarwinSSHRootLoginDisabled},
		{ID: "6.1.2", Title: "Auto-login disabled", Severity: SeverityHigh, Fn: checkDarwinAutoLogin},
		{ID: "6.1.3", Title: "Screen-saver requires password", Severity: SeverityMedium, Fn: checkDarwinScreenLock},
	}
}

func checkDarwinDefaults(domain, key, want string) func(context.Context) CheckResult {
	return func(ctx context.Context) CheckResult {
		out, err := exec.CommandContext(ctx, syspath.Defaults(), "read", domain, key).Output()
		if err != nil {
			return CheckResult{Status: StatusFail, Message: "defaults key missing: " + key}
		}
		got := strings.TrimSpace(string(out))
		if got != want {
			return CheckResult{Status: StatusFail, Message: key + " = " + got + " (want " + want + ")", Evidence: got}
		}
		return CheckResult{Status: StatusPass, Evidence: key + " = " + got}
	}
}

func checkDarwinDefaultsInt(domain, key string, accept []string) func(context.Context) CheckResult {
	return func(ctx context.Context) CheckResult {
		out, err := exec.CommandContext(ctx, syspath.Defaults(), "read", domain, key).Output()
		if err != nil {
			return CheckResult{Status: StatusFail, Message: "defaults key missing: " + key}
		}
		got := strings.TrimSpace(string(out))
		for _, a := range accept {
			if got == a {
				return CheckResult{Status: StatusPass, Evidence: key + " = " + got}
			}
		}
		return CheckResult{Status: StatusFail, Message: key + " = " + got + " (want one of " + strings.Join(accept, ",") + ")", Evidence: got}
	}
}

func checkDarwinFileVault(ctx context.Context) CheckResult {
	out, err := exec.CommandContext(ctx, syspath.Fdesetup(), "status").Output()
	if err != nil {
		return CheckResult{Status: StatusError, Message: "fdesetup unavailable: " + err.Error()}
	}
	body := strings.TrimSpace(string(out))
	if strings.Contains(strings.ToLower(body), "filevault is on") {
		return CheckResult{Status: StatusPass, Evidence: body}
	}
	return CheckResult{Status: StatusFail, Message: body, Evidence: body}
}

func checkDarwinRemoteAppleEvents(ctx context.Context) CheckResult {
	out, err := exec.CommandContext(ctx, syspath.Systemsetup(), "-getremoteappleevents").Output()
	if err != nil {
		return CheckResult{Status: StatusError, Message: "systemsetup unavailable: " + err.Error()}
	}
	body := strings.ToLower(strings.TrimSpace(string(out)))
	if strings.Contains(body, "off") {
		return CheckResult{Status: StatusPass, Evidence: strings.TrimSpace(string(out))}
	}
	return CheckResult{Status: StatusFail, Message: strings.TrimSpace(string(out)), Evidence: strings.TrimSpace(string(out))}
}

func checkDarwinGatekeeper(ctx context.Context) CheckResult {
	out, err := exec.CommandContext(ctx, syspath.Spctl(), "--status").Output()
	if err != nil {
		return CheckResult{Status: StatusError, Message: "spctl unavailable: " + err.Error()}
	}
	body := strings.TrimSpace(string(out))
	if strings.Contains(strings.ToLower(body), "assessments enabled") {
		return CheckResult{Status: StatusPass, Evidence: body}
	}
	return CheckResult{Status: StatusFail, Message: body, Evidence: body}
}

func checkDarwinSIP(ctx context.Context) CheckResult {
	out, err := exec.CommandContext(ctx, syspath.Csrutil(), "status").Output()
	if err != nil {
		return CheckResult{Status: StatusError, Message: "csrutil unavailable: " + err.Error()}
	}
	body := strings.TrimSpace(string(out))
	if strings.Contains(strings.ToLower(body), "enabled") && !strings.Contains(strings.ToLower(body), "disabled") {
		return CheckResult{Status: StatusPass, Evidence: body}
	}
	return CheckResult{Status: StatusFail, Message: body, Evidence: body}
}

func checkDarwinSSHRootLoginDisabled(ctx context.Context) CheckResult {
	out, err := exec.CommandContext(ctx, syspath.Sshd(), "-T").Output()
	if err != nil {
		return CheckResult{Status: StatusNotApplicable, Message: "sshd unavailable (Remote Login may be off)"}
	}
	for _, line := range strings.Split(string(out), "\n") {
		fields := strings.Fields(strings.TrimSpace(line))
		if len(fields) < 2 || strings.ToLower(fields[0]) != "permitrootlogin" {
			continue
		}
		if strings.EqualFold(fields[1], "no") {
			return CheckResult{Status: StatusPass, Evidence: line}
		}
		return CheckResult{Status: StatusFail, Message: line, Evidence: line}
	}
	return CheckResult{Status: StatusFail, Message: "permitrootlogin not in sshd -T output"}
}

func checkDarwinAutoLogin(ctx context.Context) CheckResult {
	// Missing autoLoginUser key → defaults errors → pass.
	out, err := exec.CommandContext(ctx, syspath.Defaults(), "read", "/Library/Preferences/com.apple.loginwindow", "autoLoginUser").Output()
	if err != nil {
		return CheckResult{Status: StatusPass, Evidence: "autoLoginUser not set"}
	}
	user := strings.TrimSpace(string(out))
	return CheckResult{Status: StatusFail, Message: "auto-login enabled for " + user, Evidence: user}
}

func checkDarwinNetworkTime(ctx context.Context) CheckResult {
	out, err := exec.CommandContext(ctx, syspath.Systemsetup(), "-getusingnetworktime").Output()
	if err != nil {
		return CheckResult{Status: StatusError, Message: "systemsetup unavailable: " + err.Error()}
	}
	body := strings.TrimSpace(string(out))
	if strings.Contains(strings.ToLower(body), "on") {
		return CheckResult{Status: StatusPass, Evidence: body}
	}
	return CheckResult{Status: StatusFail, Message: body, Evidence: body}
}

func checkDarwinLaunchdDisabled(label string) func(context.Context) CheckResult {
	return func(ctx context.Context) CheckResult {
		err := exec.CommandContext(ctx, syspath.Launchctl(), "list", label).Run()
		if err != nil {
			return CheckResult{Status: StatusPass, Evidence: label + " not loaded"}
		}
		return CheckResult{Status: StatusFail, Message: label + " is loaded", Evidence: label}
	}
}

func checkDarwinPathMode(p string, maxMode os.FileMode) func(context.Context) CheckResult {
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

func checkDarwinScreenLock(ctx context.Context) CheckResult {
	// askForPassword=1 with askForPasswordDelay ≤ 5s.
	out, err := exec.CommandContext(ctx, syspath.Defaults(), "read", "com.apple.screensaver", "askForPassword").Output()
	if err != nil {
		return CheckResult{Status: StatusFail, Message: "askForPassword not set"}
	}
	if strings.TrimSpace(string(out)) != "1" {
		return CheckResult{Status: StatusFail, Message: "askForPassword = " + strings.TrimSpace(string(out))}
	}
	delayOut, _ := exec.CommandContext(ctx, syspath.Defaults(), "read", "com.apple.screensaver", "askForPasswordDelay").Output()
	delay := strings.TrimSpace(string(delayOut))
	if delay == "" {
		return CheckResult{Status: StatusPass, Evidence: "askForPassword=1, askForPasswordDelay=immediate"}
	}
	if len(delay) <= 1 || delay == "5" || delay == "0" || delay == "1" || delay == "2" || delay == "3" || delay == "4" {
		return CheckResult{Status: StatusPass, Evidence: "askForPasswordDelay = " + delay}
	}
	return CheckResult{Status: StatusFail, Message: "askForPasswordDelay = " + delay + " (want ≤ 5)"}
}
