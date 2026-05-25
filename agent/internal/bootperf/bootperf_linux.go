//go:build linux

package bootperf

import (
	"context"
	"os/exec"
	"regexp"
	"strconv"
	"strings"
	"time"

	"github.com/itcake/agent/internal/syspath"
)

// bootDurationLine matches `Startup finished in <firmware> + <loader> + <kernel>
// + <userspace> = <total>`. Phases are optional on VMs.
var bootDurationLine = regexp.MustCompile(`(?i)^Startup finished in (.+) = .+$`)

func collect() Metrics {
	out := Metrics{Source: "systemd-analyze"}
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	cmd := exec.CommandContext(ctx, syspath.SystemdAnalyze())
	cmd.Env = append(cmd.Env, "LC_ALL=C", "LANG=C")
	raw, err := cmd.Output()
	if err == nil {
		parseSystemdAnalyze(string(raw), &out)
	}
	out.StartupItemCount = countEnabledServices(ctx)
	if out.BootTimestamp == "" {
		if t := readBootTime(); !t.IsZero() {
			out.BootTimestamp = t.UTC().Format(time.RFC3339)
		}
	}
	return out
}

func parseSystemdAnalyze(text string, out *Metrics) {
	for _, line := range strings.Split(text, "\n") {
		line = strings.TrimSpace(line)
		m := bootDurationLine.FindStringSubmatch(line)
		if m == nil {
			continue
		}
		segments := strings.Split(m[1], "+")
		for _, seg := range segments {
			seg = strings.TrimSpace(seg)
			if seg == "" {
				continue
			}
			parts := strings.Fields(seg)
			if len(parts) < 2 {
				continue
			}
			duration := parseDuration(strings.Join(parts[:len(parts)-1], " "))
			label := strings.ToLower(parts[len(parts)-1])
			switch label {
			case "(firmware)":
				out.BiosSeconds = duration
			case "(loader)":
				out.OsLoaderSeconds = duration
			case "(userspace)":
				out.DesktopReadySeconds = duration
			}
			out.TotalBootSeconds += duration
		}
		return
	}
}

// parseDuration handles "4.123s", "4,123s", "1min 12.456s", "120ms".
func parseDuration(s string) float64 {
	s = strings.ReplaceAll(s, ",", ".")
	s = strings.ReplaceAll(s, " ", "")
	var total float64
	if i := strings.Index(s, "min"); i > 0 {
		if v, err := strconv.ParseFloat(s[:i], 64); err == nil {
			total += v * 60
		}
		s = s[i+3:]
	}
	if strings.HasSuffix(s, "ms") {
		if v, err := strconv.ParseFloat(strings.TrimSuffix(s, "ms"), 64); err == nil {
			total += v / 1000.0
		}
	} else if strings.HasSuffix(s, "s") {
		if v, err := strconv.ParseFloat(strings.TrimSuffix(s, "s"), 64); err == nil {
			total += v
		}
	}
	return total
}

func countEnabledServices(ctx context.Context) int {
	cmd := exec.CommandContext(ctx, syspath.Systemctl(), "list-unit-files", "--type=service", "--state=enabled", "--no-legend", "--no-pager")
	raw, err := cmd.Output()
	if err != nil {
		return 0
	}
	count := 0
	for _, line := range strings.Split(string(raw), "\n") {
		if strings.TrimSpace(line) != "" {
			count++
		}
	}
	return count
}

func readBootTime() time.Time {
	raw, err := exec.Command(syspath.Uptime(), "-s").Output()
	if err != nil {
		return time.Time{}
	}
	t, err := time.Parse("2006-01-02 15:04:05", strings.TrimSpace(string(raw)))
	if err != nil {
		return time.Time{}
	}
	return t
}
