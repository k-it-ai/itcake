package commands

import (
	"strings"
	"testing"
)

func TestBuildServiceCommand_Linux(t *testing.T) {
	cases := map[string]string{
		"start":   "systemctl start nginx",
		"stop":    "systemctl stop nginx",
		"restart": "systemctl restart nginx",
		"enable":  "systemctl enable nginx",
		"disable": "systemctl disable nginx",
	}
	for action, want := range cases {
		got, err := BuildServiceCommand("linux", action, "nginx")
		if err != nil {
			t.Fatalf("%s: unexpected error: %v", action, err)
		}
		if got != want {
			t.Errorf("%s: got %q, want %q", action, got, want)
		}
	}
}

func TestBuildServiceCommand_Darwin(t *testing.T) {
	cases := []struct {
		action string
		want   string
	}{
		{"start", "launchctl start com.itcake.agent"},
		{"stop", "launchctl stop com.itcake.agent"},
		{"restart", "launchctl kickstart -k system/com.itcake.agent"},
		{"enable", "launchctl enable system/com.itcake.agent"},
		{"disable", "launchctl disable system/com.itcake.agent"},
	}
	for _, tc := range cases {
		got, err := BuildServiceCommand("darwin", tc.action, "com.itcake.agent")
		if err != nil {
			t.Fatalf("%s: unexpected error: %v", tc.action, err)
		}
		if got != tc.want {
			t.Errorf("%s: got %q, want %q", tc.action, got, tc.want)
		}
	}
}

func TestBuildServiceCommand_Windows(t *testing.T) {
	cases := []struct {
		action string
		want   string
	}{
		{"start", `sc.exe start "Spooler"`},
		{"stop", `sc.exe stop "Spooler"`},
		{"restart", `sc.exe stop "Spooler" & sc.exe start "Spooler"`},
		{"enable", `sc.exe config "Spooler" start= auto`},
		{"disable", `sc.exe config "Spooler" start= disabled`},
	}
	for _, tc := range cases {
		got, err := BuildServiceCommand("windows", tc.action, "Spooler")
		if err != nil {
			t.Fatalf("%s: unexpected error: %v", tc.action, err)
		}
		if got != tc.want {
			t.Errorf("%s: got %q, want %q", tc.action, got, tc.want)
		}
	}
}

func TestBuildServiceCommand_RejectsInvalidAction(t *testing.T) {
	_, err := BuildServiceCommand("linux", "destroy", "nginx")
	if err == nil {
		t.Fatal("expected error for invalid action")
	}
	if !strings.Contains(err.Error(), "invalid service action") {
		t.Errorf("unexpected error message: %v", err)
	}
}

func TestBuildServiceCommand_RejectsShellMetachars(t *testing.T) {
	// Each of these would let an attacker inject additional commands via
	// `sh -c` / `cmd.exe /c`. They must all be rejected before the format
	// string is constructed.
	bad := []string{
		"nginx; rm -rf /",
		"nginx && whoami",
		"nginx|cat /etc/passwd",
		"$(whoami)",
		"`whoami`",
		"nginx\n/bin/sh",
		"nginx\"",
		"nginx'",
		"nginx>file",
		"nginx<file",
		"nginx*",
		"nginx ",
		"",
	}
	for _, name := range bad {
		_, err := BuildServiceCommand("linux", "start", name)
		if err == nil {
			t.Errorf("expected rejection for service name %q", name)
		}
	}
}

func TestBuildServiceCommand_AcceptsRealServiceNames(t *testing.T) {
	valid := []string{
		"nginx",
		"nginx.service",
		"com.itcake.agent",
		"my-service",
		"my_service",
		"my-service@instance.service",
		"Spooler",
		"ITCakeAgent",
	}
	for _, name := range valid {
		_, err := BuildServiceCommand("linux", "start", name)
		if err != nil {
			t.Errorf("unexpected rejection for %q: %v", name, err)
		}
	}
}

func TestBuildServiceCommand_RejectsUnsupportedOS(t *testing.T) {
	_, err := BuildServiceCommand("freebsd", "start", "nginx")
	if err == nil {
		t.Fatal("expected error for unsupported OS")
	}
}

func TestBuildServiceCommand_RejectsLeadingSymbol(t *testing.T) {
	// Must start alphanumeric — prevents a name that looks like a flag
	// (e.g. `-rf`) from ever reaching systemctl.
	_, err := BuildServiceCommand("linux", "start", "-rf")
	if err == nil {
		t.Fatal("expected rejection for name starting with -")
	}
}

func TestBuildServiceCommand_RejectsOverlongName(t *testing.T) {
	long := strings.Repeat("a", 256)
	_, err := BuildServiceCommand("linux", "start", long)
	if err == nil {
		t.Fatal("expected rejection for overlong service name")
	}
}
