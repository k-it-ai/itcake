//go:build darwin

package reliability

import (
	"context"
	"os/exec"
	"strconv"
	"strings"
	"time"

	"github.com/itcake/agent/internal/syspath"
)

func collect() Aggregate {
	day := yesterday()
	out := Aggregate{Day: day}
	out.UptimeSeconds = readSysctlBootTime()

	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()

	logCmd := exec.CommandContext(ctx, syspath.Logd(), "show",
		"--start", "yesterday 00:00:00",
		"--end", "today 00:00:00",
		"--predicate", `subsystem == "com.apple.kernel" || messageType == "Fault"`,
		"--style", "compact")
	logOut, err := logCmd.Output()
	if err == nil {
		for _, line := range strings.Split(string(logOut), "\n") {
			low := strings.ToLower(line)
			switch {
			case strings.Contains(low, "panic"):
				out.Crashes++
			case strings.Contains(low, "hang") || strings.Contains(low, "watchdog"):
				out.Hangs++
			case strings.Contains(low, "kernel exception") || strings.Contains(low, "machine check") ||
				strings.Contains(low, "i/o error"):
				out.HardwareErrors++
			}
		}
	}

	lcCtx, lcCancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer lcCancel()
	lcOut, err := exec.CommandContext(lcCtx, syspath.Launchctl(), "list").Output()
	if err == nil {
		for _, line := range strings.Split(string(lcOut), "\n") {
			fields := strings.Fields(line)
			if len(fields) < 2 {
				continue
			}
			if fields[0] == "PID" || fields[0] == "-" {
				continue
			}
			if exit, err := strconv.Atoi(fields[1]); err == nil && exit != 0 {
				out.ServiceFailures++
			}
		}
	}
	return out
}

func readSysctlBootTime() int64 {
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	out, err := exec.CommandContext(ctx, syspath.Sysctl(), "-n", "kern.boottime").Output()
	if err != nil {
		return 0
	}
	s := string(out)
	idx := strings.Index(s, "sec = ")
	if idx < 0 {
		return 0
	}
	rest := s[idx+len("sec = "):]
	if comma := strings.IndexByte(rest, ','); comma >= 0 {
		rest = rest[:comma]
	}
	rest = strings.TrimSpace(rest)
	bootSec, err := strconv.ParseInt(rest, 10, 64)
	if err != nil || bootSec <= 0 {
		return 0
	}
	now := time.Now().Unix()
	if now < bootSec {
		return 0
	}
	return now - bootSec
}
