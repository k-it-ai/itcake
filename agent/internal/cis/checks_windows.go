//go:build windows

package cis

import (
	"context"
	"os/exec"
	"regexp"
	"strconv"
	"strings"
	"syscall"

	"github.com/itcake/agent/internal/syspath"
)

func platformName() string { return "windows" }

func platformChecks() []Check {
	return []Check{
		{ID: "1.1.1", Title: "Password history ≥ 24", Severity: SeverityMedium, Fn: checkWinNetAccountsField("password history length", func(n int) (bool, string) { return n >= 24, "want ≥ 24" })},
		{ID: "1.1.2", Title: "Maximum password age ≤ 365 (and ≠ 0)", Severity: SeverityMedium, Fn: checkWinNetAccountsField("maximum password age", func(n int) (bool, string) { return n > 0 && n <= 365, "want 1..365" })},
		{ID: "1.1.3", Title: "Minimum password age ≥ 1", Severity: SeverityLow, Fn: checkWinNetAccountsField("minimum password age", func(n int) (bool, string) { return n >= 1, "want ≥ 1" })},
		{ID: "1.1.4", Title: "Minimum password length ≥ 14", Severity: SeverityHigh, Fn: checkWinNetAccountsField("minimum password length", func(n int) (bool, string) { return n >= 14, "want ≥ 14" })},
		{ID: "2.3.1", Title: "Guest account disabled", Severity: SeverityHigh, Fn: checkWinGuestAccountDisabled},
		{ID: "2.3.7", Title: "DontDisplayLastUserName = 1", Severity: SeverityMedium, Fn: checkWinRegistryDword("HKLM:\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Policies\\System", "DontDisplayLastUserName", 1)},
		{ID: "9.1.1", Title: "Windows Firewall enabled on all profiles", Severity: SeverityHigh, Fn: checkWinFirewallAllProfiles},
		{ID: "17.1.1", Title: "Audit Credential Validation = Success and Failure", Severity: SeverityMedium, Fn: checkWinAuditCredentialValidation},
		{ID: "18.4.1", Title: "LocalAccountTokenFilterPolicy ≠ 1 (UAC remote enforcement)", Severity: SeverityMedium, Fn: checkWinUACRemoteRestriction},
		{ID: "18.9.4", Title: "NoGPOListChanges = 0 (background GPO refresh)", Severity: SeverityLow, Fn: checkWinRegistryDword("HKLM:\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Policies\\System", "NoGPOListChanges", 0)},
	}
}

func powershell(ctx context.Context, script string) (string, error) {
	cmd := exec.CommandContext(ctx, syspath.PowerShell(), "-NoProfile", "-NonInteractive", "-Command", script)
	cmd.SysProcAttr = &syscall.SysProcAttr{HideWindow: true, CreationFlags: 0x08000000}
	raw, err := cmd.Output()
	return string(raw), err
}

var trailingDigitsRE = regexp.MustCompile(`(-?\d+|None|Never|0\b)\s*$`)

func checkWinNetAccountsField(field string, ok func(int) (bool, string)) func(context.Context) CheckResult {
	return func(ctx context.Context) CheckResult {
		out, err := exec.CommandContext(ctx, syspath.NetExe(), "accounts").Output()
		if err != nil {
			return CheckResult{Status: StatusError, Message: "net accounts unavailable: " + err.Error()}
		}
		// Walk lines case-insensitively for the leading label, then parse the
		// numeric tail. "None"/"Never" come back when the policy is unset.
		fieldLower := strings.ToLower(field)
		for _, line := range strings.Split(string(out), "\n") {
			s := strings.TrimSpace(line)
			lo := strings.ToLower(s)
			if !strings.HasPrefix(lo, fieldLower) {
				continue
			}
			tail := strings.TrimSpace(s[len(field):])
			if strings.EqualFold(tail, "none") || strings.EqualFold(tail, "never") {
				return CheckResult{Status: StatusFail, Message: field + " unset"}
			}
			m := trailingDigitsRE.FindString(tail)
			if m == "" {
				continue
			}
			n, err := strconv.Atoi(m)
			if err != nil {
				continue
			}
			passed, hint := ok(n)
			if !passed {
				return CheckResult{Status: StatusFail, Message: field + " = " + strconv.Itoa(n) + " (" + hint + ")", Evidence: m}
			}
			return CheckResult{Status: StatusPass, Evidence: field + " = " + strconv.Itoa(n)}
		}
		return CheckResult{Status: StatusFail, Message: field + " not found in net accounts output"}
	}
}

func checkWinGuestAccountDisabled(ctx context.Context) CheckResult {
	out, err := powershell(ctx, "(Get-LocalUser -Name Guest).Enabled")
	if err != nil {
		return CheckResult{Status: StatusError, Message: err.Error()}
	}
	body := strings.TrimSpace(out)
	if strings.EqualFold(body, "False") {
		return CheckResult{Status: StatusPass, Evidence: "Guest.Enabled = False"}
	}
	return CheckResult{Status: StatusFail, Message: "Guest.Enabled = " + body}
}

func checkWinRegistryDword(path, name string, want int) func(context.Context) CheckResult {
	return func(ctx context.Context) CheckResult {
		script := "$ErrorActionPreference='SilentlyContinue'; (Get-ItemProperty -Path '" + path + "' -Name '" + name + "').'" + name + "'"
		out, err := powershell(ctx, script)
		if err != nil {
			return CheckResult{Status: StatusError, Message: err.Error()}
		}
		body := strings.TrimSpace(out)
		if body == "" {
			// Absent — treat as default-pass for the LAToken case (default is 0)
			// but here we report what we actually checked.
			if want == 0 {
				return CheckResult{Status: StatusPass, Evidence: name + " not set (default 0)"}
			}
			return CheckResult{Status: StatusFail, Message: name + " not set"}
		}
		got, err := strconv.Atoi(body)
		if err != nil {
			return CheckResult{Status: StatusError, Message: "non-integer registry value: " + body}
		}
		if got != want {
			return CheckResult{Status: StatusFail, Message: name + " = " + body + " (want " + strconv.Itoa(want) + ")", Evidence: body}
		}
		return CheckResult{Status: StatusPass, Evidence: name + " = " + body}
	}
}

func checkWinFirewallAllProfiles(ctx context.Context) CheckResult {
	out, err := powershell(ctx, "Get-NetFirewallProfile | ForEach-Object { $_.Name + ':' + $_.Enabled }")
	if err != nil {
		return CheckResult{Status: StatusError, Message: err.Error()}
	}
	for _, line := range strings.Split(out, "\n") {
		s := strings.TrimSpace(line)
		if s == "" {
			continue
		}
		parts := strings.SplitN(s, ":", 2)
		if len(parts) != 2 || !strings.EqualFold(strings.TrimSpace(parts[1]), "true") {
			return CheckResult{Status: StatusFail, Message: "profile not enabled: " + s, Evidence: s}
		}
	}
	return CheckResult{Status: StatusPass, Evidence: strings.TrimSpace(out)}
}

func checkWinAuditCredentialValidation(ctx context.Context) CheckResult {
	out, err := exec.CommandContext(ctx, syspath.Auditpol(), "/get", "/subcategory:Credential Validation").Output()
	if err != nil {
		return CheckResult{Status: StatusError, Message: err.Error()}
	}
	body := strings.ToLower(string(out))
	if strings.Contains(body, "success and failure") {
		return CheckResult{Status: StatusPass}
	}
	return CheckResult{Status: StatusFail, Message: strings.TrimSpace(string(out)), Evidence: strings.TrimSpace(string(out))}
}

// LocalAccountTokenFilterPolicy: default-absent = pass (Windows enforces UAC
// for remote logons by default). Any value of 1 disables that — fail.
func checkWinUACRemoteRestriction(ctx context.Context) CheckResult {
	script := "$ErrorActionPreference='SilentlyContinue'; (Get-ItemProperty -Path 'HKLM:\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Policies\\System' -Name 'LocalAccountTokenFilterPolicy').'LocalAccountTokenFilterPolicy'"
	out, err := powershell(ctx, script)
	if err != nil {
		return CheckResult{Status: StatusError, Message: err.Error()}
	}
	body := strings.TrimSpace(out)
	if body == "" || body == "0" {
		return CheckResult{Status: StatusPass, Evidence: "LocalAccountTokenFilterPolicy = " + body}
	}
	return CheckResult{Status: StatusFail, Message: "LocalAccountTokenFilterPolicy = " + body + " (UAC remote enforcement disabled)"}
}
