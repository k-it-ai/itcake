package commands

import (
	"strings"
	"testing"

	"github.com/itcake/agent/internal/syspath"
)

func plansOK(t *testing.T, goos, action, name string) []ServicePlan {
	t.Helper()
	p, err := BuildServicePlans(goos, action, name)
	if err != nil {
		t.Fatalf("%s/%s/%s: unexpected error: %v", goos, action, name, err)
	}
	return p
}

func TestBuildServicePlans_Linux(t *testing.T) {
	sc := syspath.Systemctl()
	cases := map[string][]string{
		"start":   {"start", "nginx"},
		"stop":    {"stop", "nginx"},
		"restart": {"restart", "nginx"},
		"enable":  {"enable", "nginx"},
		"disable": {"disable", "nginx"},
	}
	for action, args := range cases {
		p := plansOK(t, "linux", action, "nginx")
		if len(p) != 1 || p[0].Bin != sc || !equalSlice(p[0].Args, args) {
			t.Errorf("%s: got %+v, want bin=%s args=%v", action, p, sc, args)
		}
	}
}

func TestBuildServicePlans_Darwin(t *testing.T) {
	lc := syspath.Launchctl()
	cases := []struct {
		action string
		args   []string
	}{
		{"start", []string{"start", "com.itcake.agent"}},
		{"stop", []string{"stop", "com.itcake.agent"}},
		{"restart", []string{"kickstart", "-k", "system/com.itcake.agent"}},
		{"enable", []string{"enable", "system/com.itcake.agent"}},
		{"disable", []string{"disable", "system/com.itcake.agent"}},
	}
	for _, tc := range cases {
		p := plansOK(t, "darwin", tc.action, "com.itcake.agent")
		if len(p) != 1 || p[0].Bin != lc || !equalSlice(p[0].Args, tc.args) {
			t.Errorf("%s: got %+v, want bin=%s args=%v", tc.action, p, lc, tc.args)
		}
	}
}

func TestBuildServicePlans_Windows(t *testing.T) {
	sc := syspath.ScExe()
	cases := []struct {
		action string
		want   []ServicePlan
	}{
		{"start", []ServicePlan{{Bin: sc, Args: []string{"start", "Spooler"}}}},
		{"stop", []ServicePlan{{Bin: sc, Args: []string{"stop", "Spooler"}}}},
		{"restart", []ServicePlan{
			{Bin: sc, Args: []string{"stop", "Spooler"}},
			{Bin: sc, Args: []string{"start", "Spooler"}},
		}},
		{"enable", []ServicePlan{{Bin: sc, Args: []string{"config", "Spooler", "start=", "auto"}}}},
		{"disable", []ServicePlan{{Bin: sc, Args: []string{"config", "Spooler", "start=", "disabled"}}}},
	}
	for _, tc := range cases {
		got := plansOK(t, "windows", tc.action, "Spooler")
		if len(got) != len(tc.want) {
			t.Errorf("%s: got %d plans, want %d", tc.action, len(got), len(tc.want))
			continue
		}
		for i := range got {
			if got[i].Bin != tc.want[i].Bin || !equalSlice(got[i].Args, tc.want[i].Args) {
				t.Errorf("%s[%d]: got %+v, want %+v", tc.action, i, got[i], tc.want[i])
			}
		}
	}
}

func TestBuildServicePlans_RejectsInvalidAction(t *testing.T) {
	_, err := BuildServicePlans("linux", "destroy", "nginx")
	if err == nil {
		t.Fatal("expected error for invalid action")
	}
	if !strings.Contains(err.Error(), "invalid service action") {
		t.Errorf("unexpected error message: %v", err)
	}
}

func TestBuildServicePlans_RejectsShellMetachars(t *testing.T) {
	// Argv-form execution makes these injection-safe at the runtime
	// layer, but the regex is defense-in-depth and operator-recognisable.
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
		_, err := BuildServicePlans("linux", "start", name)
		if err == nil {
			t.Errorf("expected rejection for service name %q", name)
		}
	}
}

func TestBuildServicePlans_AcceptsRealServiceNames(t *testing.T) {
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
		_, err := BuildServicePlans("linux", "start", name)
		if err != nil {
			t.Errorf("unexpected rejection for %q: %v", name, err)
		}
	}
}

func TestBuildServicePlans_RejectsUnsupportedOS(t *testing.T) {
	_, err := BuildServicePlans("freebsd", "start", "nginx")
	if err == nil {
		t.Fatal("expected error for unsupported OS")
	}
}

func TestBuildServicePlans_RejectsLeadingSymbol(t *testing.T) {
	// Must start alphanumeric — prevents a name that looks like a flag
	// (e.g. `-rf`) from ever reaching systemctl as an argument.
	_, err := BuildServicePlans("linux", "start", "-rf")
	if err == nil {
		t.Fatal("expected rejection for name starting with -")
	}
}

func TestBuildServicePlans_RejectsOverlongName(t *testing.T) {
	long := strings.Repeat("a", 256)
	_, err := BuildServicePlans("linux", "start", long)
	if err == nil {
		t.Fatal("expected rejection for overlong service name")
	}
}

func equalSlice(a, b []string) bool {
	if len(a) != len(b) {
		return false
	}
	for i := range a {
		if a[i] != b[i] {
			return false
		}
	}
	return true
}
