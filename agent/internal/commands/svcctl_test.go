package commands

import (
	"fmt"
	"strings"
	"testing"

	"github.com/itcake/agent/internal/syspath"
)

func TestBuildServiceCommand_Linux(t *testing.T) {
	sc := syspath.Systemctl()
	cases := map[string]string{
		"start":   fmt.Sprintf("%s start nginx", sc),
		"stop":    fmt.Sprintf("%s stop nginx", sc),
		"restart": fmt.Sprintf("%s restart nginx", sc),
		"enable":  fmt.Sprintf("%s enable nginx", sc),
		"disable": fmt.Sprintf("%s disable nginx", sc),
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
	lc := syspath.Launchctl()
	cases := []struct {
		action string
		want   string
	}{
		{"start", fmt.Sprintf("%s start com.itcake.agent", lc)},
		{"stop", fmt.Sprintf("%s stop com.itcake.agent", lc)},
		{"restart", fmt.Sprintf("%s kickstart -k system/com.itcake.agent", lc)},
		{"enable", fmt.Sprintf("%s enable system/com.itcake.agent", lc)},
		{"disable", fmt.Sprintf("%s disable system/com.itcake.agent", lc)},
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
	sc := `"` + syspath.ScExe() + `"`
	cases := []struct {
		action string
		want   string
	}{
		{"start", fmt.Sprintf(`%s start "Spooler"`, sc)},
		{"stop", fmt.Sprintf(`%s stop "Spooler"`, sc)},
		{"restart", fmt.Sprintf(`%s stop "Spooler" & %s start "Spooler"`, sc, sc)},
		{"enable", fmt.Sprintf(`%s config "Spooler" start= auto`, sc)},
		{"disable", fmt.Sprintf(`%s config "Spooler" start= disabled`, sc)},
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
