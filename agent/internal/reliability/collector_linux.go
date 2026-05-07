//go:build linux

package reliability

import (
	"context"
	"os"
	"os/exec"
	"strconv"
	"strings"
	"time"
)

func collect() Aggregate {
	day := yesterday()
	out := Aggregate{Day: day}
	out.UptimeSeconds = readProcUptime()

	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()

	args := []string{
		"--since", "yesterday 00:00",
		"--until", "today 00:00",
		"--priority=err",
		"--no-pager",
	}
	cmd := exec.CommandContext(ctx, "journalctl", args...)
	stdout, err := cmd.Output()
	if err != nil {
		return out
	}

	for _, line := range strings.Split(string(stdout), "\n") {
		c := classifyLinuxLine(line)
		switch c {
		case classCrash:
			out.Crashes++
		case classHang:
			out.Hangs++
		case classServiceFail:
			out.ServiceFailures++
		case classHardware:
			out.HardwareErrors++
		}
	}
	return out
}

type lineClass int

const (
	classNone lineClass = iota
	classCrash
	classHang
	classServiceFail
	classHardware
)

// ClassifyLinuxLine categorises a single journalctl line. Exposed (via the
// public wrapper) for table-driven tests in collector_test.go.
func classifyLinuxLine(line string) lineClass {
	low := strings.ToLower(line)
	if low == "" {
		return classNone
	}
	if strings.Contains(low, "oom-killer") || strings.Contains(low, "out of memory: kill") {
		return classCrash
	}
	if strings.Contains(low, "segfault") || strings.Contains(low, "general protection fault") {
		return classCrash
	}
	if strings.Contains(low, "kernel panic") {
		return classCrash
	}
	if strings.Contains(low, "coredump") || strings.Contains(low, "core dumped") || strings.Contains(low, "systemd-coredump") {
		return classCrash
	}
	if strings.Contains(low, "hung_task") || strings.Contains(low, "hung task") || strings.Contains(low, "blocked for more than") {
		return classHang
	}
	if strings.Contains(low, "soft lockup") || strings.Contains(low, "rcu_sched detected") {
		return classHang
	}
	if strings.Contains(low, "failed with result 'exit-code'") ||
		strings.Contains(low, "failed with result 'core-dump'") ||
		strings.Contains(low, "failed with result 'signal'") ||
		strings.Contains(low, "failed with result 'timeout'") {
		return classServiceFail
	}
	if strings.Contains(low, "service entered failed state") {
		return classServiceFail
	}
	if strings.Contains(low, "i/o error") || strings.Contains(low, "ata error") ||
		strings.Contains(low, "mce: ") || strings.Contains(low, "machine check") {
		return classHardware
	}
	return classNone
}

func readProcUptime() int64 {
	data, err := os.ReadFile("/proc/uptime")
	if err != nil {
		return 0
	}
	fields := strings.Fields(string(data))
	if len(fields) == 0 {
		return 0
	}
	f, err := strconv.ParseFloat(fields[0], 64)
	if err != nil || f < 0 {
		return 0
	}
	return int64(f)
}
