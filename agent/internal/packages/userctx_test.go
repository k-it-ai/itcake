//go:build !windows

package packages

import "testing"

// M8 regression: usernames captured from $SUDO_USER / logname / stat output
// are interpolated into shell command strings (`/bin/sh -c "sudo -u $USER brew ..."`).
// isValidUsername must reject anything outside the POSIX-portable shape so a
// crafted SUDO_USER like "alice; rm -rf /" can never reach the shell.

func TestIsValidUsername_AcceptsValid(t *testing.T) {
	for _, u := range []string{"alice", "bob_42", "_internal", "x", "user-name", "a0123456789012345678901234567890"} {
		if !isValidUsername(u) {
			t.Errorf("expected %q to be valid", u)
		}
	}
}

func TestIsValidUsername_RejectsRootAndEmpty(t *testing.T) {
	for _, u := range []string{"", "root"} {
		if isValidUsername(u) {
			t.Errorf("expected %q to be rejected", u)
		}
	}
}

func TestIsValidUsername_RejectsShellMetacharacters(t *testing.T) {
	cases := []string{
		"alice; rm -rf /",
		"alice && id",
		"alice || true",
		"$(whoami)",
		"`whoami`",
		"alice|cat",
		"alice\nrm",
		"alice ", // trailing space
		" alice", // leading space
		"alice'",
		"alice\"",
		"alice\\",
		"alice/etc",
		"alice<",
		"alice>",
		"Alice", // upper-case is non-portable; reject for safety
	}
	for _, u := range cases {
		if isValidUsername(u) {
			t.Errorf("expected shell-injection candidate %q to be rejected", u)
		}
	}
}

func TestIsValidUsername_RejectsLongerThan32(t *testing.T) {
	tooLong := "a" + string(make([]byte, 32)) // 33 bytes total — but make([]byte,32) is null bytes, so let's use letters
	long33 := "a"
	for i := 0; i < 32; i++ {
		long33 += "a"
	}
	if isValidUsername(long33) {
		t.Errorf("expected %d-char username to be rejected (POSIX cap is 32)", len(long33))
	}
	_ = tooLong
}

func TestIsValidUsername_RejectsLeadingDigit(t *testing.T) {
	if isValidUsername("1alice") {
		t.Error("expected leading-digit username to be rejected (POSIX requires letter or _)")
	}
}
