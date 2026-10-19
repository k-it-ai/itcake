//go:build !windows

package commands

import "testing"

// Regression: the macOS `stat -f %Su /dev/console` capture in executor.go
// flows directly into `sudo -u <user>` as a separate argv element. Even
// though `exec.CommandContext` doesn't invoke a shell, a malformed
// username (uppercase, spaces, leading dash, shell metacharacters) would
// at best fail noisily on every dispatch and at worst behave unexpectedly
// — see the parity discussion in packages/userctx.go where the same
// regex already guards SUDO_USER. This test pins the regex so a future
// refactor of executor.go can't drop the gate silently.

func TestConsoleUsernameRE_Accepts(t *testing.T) {
	for _, u := range []string{"alice", "bob_42", "_internal", "x", "user-name", "abcdef0123456789012345678901234"} {
		if !consoleUsernameRE.MatchString(u) {
			t.Errorf("expected %q to be accepted", u)
		}
	}
}

func TestConsoleUsernameRE_Rejects(t *testing.T) {
	for _, u := range []string{
		"",
		"-alice", // leading dash
		"Alice",  // uppercase
		"al ice", // space
		"alice; sudo -u root sh",
		"alice`whoami`",
		"alice$(id)",
		"alice|cat",
		"alice\nrm",
		"a/b",
		"a:b",
		"a@b",
		"01alice",                           // leading digit (POSIX-portable disallows)
		"abcdef012345678901234567890123456", // 33 chars > limit (regex allows 32)
	} {
		if consoleUsernameRE.MatchString(u) {
			t.Errorf("expected %q to be REJECTED", u)
		}
	}
}
