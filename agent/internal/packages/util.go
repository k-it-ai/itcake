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
