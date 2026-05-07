//go:build windows

package reliability

import (
	"context"
	"os/exec"
	"strings"
	"time"

	"github.com/itcake/agent/internal/syspath"
)

func collect() Aggregate {
	day := yesterday()
	out := Aggregate{Day: day}
	out.UptimeSeconds = readWindowsUptime()

	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()

	sysCmd := exec.CommandContext(ctx, syspath.Wevtutil(), "qe", "System",
		"/q:*[System[(Level=2 or Level=1)]]", "/f:text", "/c:500", "/rd:true")
	if sysOut, err := sysCmd.Output(); err == nil {
		for _, line := range strings.Split(string(sysOut), "\n") {
			low := strings.ToLower(line)
			switch {
			case strings.Contains(low, "the previous system shutdown") &&
				strings.Contains(low, "was unexpected"):
				out.Crashes++
			case strings.Contains(low, "bugcheck"):
				out.Crashes++
			case strings.Contains(low, "service control manager") &&
				strings.Contains(low, "terminated unexpectedly"):
				out.ServiceFailures++
			case strings.Contains(low, "service") && strings.Contains(low, "failed to start"):
				out.ServiceFailures++
			case strings.Contains(low, "the application is hung") ||
				strings.Contains(low, "hung application"):
				out.Hangs++
			case strings.Contains(low, "disk") && strings.Contains(low, "bad block"):
				out.HardwareErrors++
			case strings.Contains(low, "machine check exception"):
				out.HardwareErrors++
			case strings.Contains(low, "the device") && strings.Contains(low, "has a bad block"):
				out.HardwareErrors++
			}
		}
	}

	kpCtx, kpCancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer kpCancel()
	kpCmd := exec.CommandContext(kpCtx, syspath.Wevtutil(), "qe",
		"Microsoft-Windows-Kernel-Power/System",
		"/q:*[System[(EventID=41)]]", "/f:text", "/c:50", "/rd:true")
	if kpOut, err := kpCmd.Output(); err == nil {
		for _, line := range strings.Split(string(kpOut), "\n") {
			if strings.Contains(strings.ToLower(line), "event id: 41") {
				out.Crashes++
			}
		}
	}
	return out
}

func readWindowsUptime() int64 {
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	out, err := exec.CommandContext(ctx, syspath.NetExe(), "statistics", "server").Output()
	if err != nil {
		return 0
	}
	for _, line := range strings.Split(string(out), "\n") {
		low := strings.ToLower(line)
		if strings.Contains(low, "statistics since") {
			parts := strings.SplitN(line, "since", 2)
			if len(parts) == 2 {
				if t, err := time.Parse("1/2/2006 3:04:05 PM", strings.TrimSpace(parts[1])); err == nil {
					delta := time.Since(t)
					if delta < 0 {
						return 0
					}
					return int64(delta.Seconds())
				}
			}
		}
	}
	return 0
}
