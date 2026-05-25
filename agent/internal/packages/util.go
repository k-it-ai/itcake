package packages

import (
	"errors"
	"regexp"
	"strings"
)

func splitLines(s string) []string {
	s = strings.TrimSpace(s)
	if s == "" {
		return nil
	}
	return strings.Split(s, "\n")
}

func splitFields(s string) []string {
	return strings.Fields(strings.TrimSpace(s))
}

// pkgNameRE accepts npm/brew/dnf/etc package names; rejects shell metacharacters
// so `; reboot` or `$(id)` can't escape /bin/sh -c interpolation in builders.
var pkgNameRE = regexp.MustCompile(`^[A-Za-z0-9@][A-Za-z0-9._+@:/\-]{0,127}$`)

// ValidatePackageName fails closed before names reach shell-string builders.
func ValidatePackageName(name string) error {
	if name == "" {
		return errors.New("package name is required")
	}
	if !pkgNameRE.MatchString(name) {
		return errors.New("package name contains invalid characters or is too long")
	}
	return nil
}

// shellQuote returns s safely single-quoted for /bin/sh.
func shellQuote(s string) string {
	return "'" + strings.ReplaceAll(s, "'", `'\''`) + "'"
}

// planToShell renders an ExecPlan as a /bin/sh-quoted string for the legacy
// *Command() API. Every Argv element is single-quoted.
func planToShell(p *ExecPlan) string {
	if p == nil {
		return ""
	}
	if p.Argv == nil {
		return p.ShellScript
	}
	if p.Binary == "" {
		return ""
	}
	parts := make([]string, 0, 1+len(p.Argv))
	parts = append(parts, shellQuote(p.Binary))
	for _, a := range p.Argv {
		parts = append(parts, shellQuote(a))
	}
	return strings.Join(parts, " ")
}
