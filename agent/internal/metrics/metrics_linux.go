package metrics

import (
	"os"
	"strconv"
	"strings"
	"syscall"
	"time"
)

// Collect gathers system metrics on Linux from /proc and syscall.
func Collect() (*SystemMetrics, error) {
	m := &SystemMetrics{}

	if cpu, err := readCPUPercent(); err == nil {
		m.CPUPercent = ptrFloat(cpu)
	}

	// Prefer MemAvailable (kernel ≥3.14) — MemFree alone overstates "used"
	// because it ignores reclaimable page cache.
	if memInfo, err := os.ReadFile("/proc/meminfo"); err == nil {
		fields := parseMeminfo(string(memInfo))
		if total, ok := fields["MemTotal"]; ok {
			m.MemoryTotalBytes = ptrInt64(total * 1024)
			avail := int64(0)
			if a, ok := fields["MemAvailable"]; ok {
				avail = a
			} else if f, ok := fields["MemFree"]; ok {
				avail = f
			}
			m.MemoryUsedBytes = ptrInt64((total - avail) * 1024)
		}
	}

	var stat syscall.Statfs_t
	if err := syscall.Statfs("/", &stat); err == nil {
		total := int64(stat.Blocks) * int64(stat.Bsize)
		free := int64(stat.Bfree) * int64(stat.Bsize)
		m.DiskTotalBytes = ptrInt64(total)
		m.DiskUsedBytes = ptrInt64(total - free)
	}

	if data, err := os.ReadFile("/proc/loadavg"); err == nil {
		parts := strings.Fields(string(data))
		if len(parts) >= 3 {
			if v, err := strconv.ParseFloat(parts[0], 64); err == nil {
				m.LoadAvg1 = ptrFloat(v)
			}
			if v, err := strconv.ParseFloat(parts[1], 64); err == nil {
				m.LoadAvg5 = ptrFloat(v)
			}
			if v, err := strconv.ParseFloat(parts[2], 64); err == nil {
				m.LoadAvg15 = ptrFloat(v)
			}
		}
	}

	if data, err := os.ReadFile("/proc/uptime"); err == nil {
		parts := strings.Fields(string(data))
		if len(parts) >= 1 {
			if v, err := strconv.ParseFloat(parts[0], 64); err == nil {
				m.UptimeSeconds = ptrInt64(int64(v))
			}
		}
	}

	return m, nil
}

func parseMeminfo(data string) map[string]int64 {
	result := make(map[string]int64)
	for _, line := range strings.Split(data, "\n") {
		parts := strings.SplitN(line, ":", 2)
		if len(parts) != 2 {
			continue
		}
		key := strings.TrimSpace(parts[0])
		valStr := strings.TrimSpace(parts[1])
		valStr = strings.TrimSuffix(valStr, " kB")
		valStr = strings.TrimSpace(valStr)
		if v, err := strconv.ParseInt(valStr, 10, 64); err == nil {
			result[key] = v
		}
	}
	return result
}

type cpuTimes struct {
	idle  uint64
	total uint64
}

func readCPUTimes() (*cpuTimes, error) {
	data, err := os.ReadFile("/proc/stat")
	if err != nil {
		return nil, err
	}
	lines := strings.Split(string(data), "\n")
	for _, line := range lines {
		if !strings.HasPrefix(line, "cpu ") {
			continue
		}
		fields := strings.Fields(line)
		if len(fields) < 5 {
			continue
		}
		var total, idle uint64
		for i := 1; i < len(fields); i++ {
			v, err := strconv.ParseUint(fields[i], 10, 64)
			if err != nil {
				continue
			}
			total += v
			if i == 4 {
				// /proc/stat idle field
				idle = v
			}
		}
		return &cpuTimes{idle: idle, total: total}, nil
	}
	return nil, os.ErrNotExist
}

func readCPUPercent() (float64, error) {
	t1, err := readCPUTimes()
	if err != nil {
		return 0, err
	}
	time.Sleep(500 * time.Millisecond)
	t2, err := readCPUTimes()
	if err != nil {
		return 0, err
	}
	deltaTotal := float64(t2.total - t1.total)
	deltaIdle := float64(t2.idle - t1.idle)
	if deltaTotal <= 0 {
		return 0, nil
	}
	return (1.0 - deltaIdle/deltaTotal) * 100.0, nil
}
