//go:build darwin

package bootperf

import (
	"context"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"time"
)

// macOS does not expose BIOS / loader phases. We can only measure the
// time between kern.boottime and the first loginwindow event, which we
// classify as "desktop ready". Bios/Loader stay 0.

var bootTimeRE = regexp.MustCompile(`sec\s*=\s*(\d+)`)

func collect() Metrics {
	out := Metrics{Source: "log show + sysctl"}
	bt := readBootTime()
	if !bt.IsZero() {
		out.BootTimestamp = bt.UTC().Format(time.RFC3339)
	}
	if !bt.IsZero() {
		ctx, cancel := context.WithTimeout(context.Background(), 8*time.Second)
		defer cancel()
		// `log show --last boot` gathers events since last boot. We grep
		// for the first loginwindow notification.
		cmd := exec.CommandContext(ctx,
			"log", "show",
			"--style", "compact",
			"--predicate", `process == "loginwindow"`,
			"--last", "boot",
		)
		raw, err := cmd.Output()
		if err == nil {
			if t := firstEntryTime(string(raw)); !t.IsZero() && t.After(bt) {
				out.DesktopReadySeconds = t.Sub(bt).Seconds()
				out.TotalBootSeconds = out.DesktopReadySeconds
			}
		}
	}
	out.StartupItemCount = countLaunchAgents()
	return out
}

func readBootTime() time.Time {
	raw, err := exec.Command("sysctl", "-n", "kern.boottime").Output()
	if err != nil {
		return time.Time{}
	}
	m := bootTimeRE.FindStringSubmatch(string(raw))
	if m == nil {
		return time.Time{}
	}
	sec, err := strconv.ParseInt(m[1], 10, 64)
	if err != nil {
		return time.Time{}
	}
	return time.Unix(sec, 0)
}

// firstEntryTime parses the first non-empty `log show --style compact` line.
// Format example: `2026-01-15 09:33:08.012345+0000 0x123    Default ... `
func firstEntryTime(out string) time.Time {
	for _, line := range strings.Split(out, "\n") {
		line = strings.TrimSpace(line)
		if line == "" {
			continue
		}
		fields := strings.Fields(line)
		if len(fields) < 2 {
			continue
		}
		ts := fields[0] + " " + fields[1]
		// Trim sub-second precision past 6 digits — log show emits 6.
		t, err := time.Parse("2006-01-02 15:04:05.999999-0700", ts)
		if err == nil {
			return t
		}
	}
	return time.Time{}
}

func countLaunchAgents() int {
	dirs := []string{"/Library/LaunchDaemons", "/Library/LaunchAgents"}
	if home, err := os.UserHomeDir(); err == nil {
		dirs = append(dirs, filepath.Join(home, "Library", "LaunchAgents"))
	}
	count := 0
	for _, d := range dirs {
		entries, err := os.ReadDir(d)
		if err != nil {
			continue
		}
		for _, e := range entries {
			if !e.IsDir() && strings.HasSuffix(e.Name(), ".plist") {
				count++
			}
		}
	}
	return count
}
