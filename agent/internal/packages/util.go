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

// pkgNameRE: leading letter/digit/@ (npm scope), then letters/digits/._+@:/-
// covers apt/dnf/pacman/apk (multi-arch suffix `:`), brew taps (`vendor/tap/pkg`),
// npm scopes (`@scope/pkg`), pip names with `+`/`.`, cask bundle ids
// (`org.mozilla.firefox`). REJECTS spaces, quotes, $, ;, &, |, *, ?, etc. so
// the name cannot escape /bin/sh -c interpolation in InstallCommand builders.
var pkgNameRE = regexp.MustCompile(`^[A-Za-z0-9@][A-Za-z0-9._+@:/\-]{0,127}$`)

// ValidatePackageName fails closed: the agent runs as root, builders concatenate
// `pkg` directly into shell strings (apt/dnf/pacman/apk/npm/pip/brew). A name
// like `; reboot` or `$(id)` would execute as root without this guard.
func ValidatePackageName(name string) error {
	if name == "" {
		return errors.New("package name is required")
	}
	if !pkgNameRE.MatchString(name) {
		return errors.New("package name contains invalid characters or is too long")
	}
	return nil
}

// shellQuote returns s safely single-quoted for /bin/sh. Any embedded
// single quote is escaped as `'\''`. Used by the legacy *Command()
// methods (kept only for backward compat) — new code should populate
// ExecPlan.Argv instead, which bypasses /bin/sh entirely.
func shellQuote(s string) string {
	return "'" + strings.ReplaceAll(s, "'", `'\''`) + "'"
}

// planToShell renders an ExecPlan back to a /bin/sh-quoted command
// string. Used by the legacy *Command() interface methods so callers
// that still want a shell string get one. The Argv path produces
// `'binary' 'arg1' 'arg2'...` — every element is single-quoted so
// metacharacters cannot escape; this preserves the strong guarantee
// that ValidatePackageName already provides at the upstream layer.
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
