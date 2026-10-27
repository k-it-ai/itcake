package metrics

import (
	"context"
	"os/exec"
	"strconv"
	"strings"
	"syscall"
	"time"

	"github.com/itcake/agent/internal/syspath"
)

// cmdTimeout bounds every external command Collect runs. A hung sysctl /
// diskutil / ps (common on constrained or virtualised hosts) must never stall
// the check-in loop — a stuck metrics collection would block command delivery
// and leave server-side commands pending forever.
const cmdTimeout = 5 * time.Second

func runCmd(name string, args ...string) ([]byte, error) {
	ctx, cancel := context.WithTimeout(context.Background(), cmdTimeout)
	defer cancel()
	return exec.CommandContext(ctx, name, args...).Output()
}

// Collect gathers system metrics on macOS using sysctl and vm_stat.
func Collect() (*SystemMetrics, error) {
	m := &SystemMetrics{}

	if cpu, err := readCPUPercent(); err == nil {
		m.CPUPercent = ptrFloat(cpu)
	}

	if out, err := runCmd(syspath.Sysctl(), "-n", "hw.memsize"); err == nil {
		if total, err := strconv.ParseInt(strings.TrimSpace(string(out)), 10, 64); err == nil {
			m.MemoryTotalBytes = ptrInt64(total)

			if vmOut, err := runCmd(syspath.VMStat()); err == nil {
				pages := parseVMStat(string(vmOut))
				pageSize := int64(4096)
				if ps, ok := pages["page_size"]; ok {
					pageSize = ps
				}
				free := pages["Pages free"] * pageSize
				speculative := pages["Pages speculative"] * pageSize
				purgeable := pages["Pages purgeable"] * pageSize
				used := total - free - speculative - purgeable
				if used < 0 {
					used = total - free
				}
				m.MemoryUsedBytes = ptrInt64(used)
			}
		}
	}

	if out, err := runCmd(syspath.Diskutil(), "info", "-plist", "/"); err == nil {
		totalDisk := parsePlistInt(string(out), "TotalSize")
		freeDisk := parsePlistInt(string(out), "APFSContainerFree")
		if freeDisk == 0 {
			freeDisk = parsePlistInt(string(out), "FreeSpace")
		}
		if totalDisk > 0 {
			m.DiskTotalBytes = ptrInt64(totalDisk)
			m.DiskUsedBytes = ptrInt64(totalDisk - freeDisk)
		}
	}
	if m.DiskTotalBytes == nil {
		var stat syscall.Statfs_t
		if err := syscall.Statfs("/", &stat); err == nil {
			total := int64(stat.Blocks) * int64(stat.Bsize)
			free := int64(stat.Bfree) * int64(stat.Bsize)
			m.DiskTotalBytes = ptrInt64(total)
			m.DiskUsedBytes = ptrInt64(total - free)
		}
	}

	if out, err := runCmd(syspath.Sysctl(), "-n", "vm.loadavg"); err == nil {
		// vm.loadavg output: "{ 1.23 4.56 7.89 }"
		s := strings.Trim(strings.TrimSpace(string(out)), "{}")
		fields := strings.Fields(s)
		if len(fields) >= 3 {
			if v, err := strconv.ParseFloat(fields[0], 64); err == nil {
				m.LoadAvg1 = ptrFloat(v)
			}
			if v, err := strconv.ParseFloat(fields[1], 64); err == nil {
				m.LoadAvg5 = ptrFloat(v)
			}
			if v, err := strconv.ParseFloat(fields[2], 64); err == nil {
				m.LoadAvg15 = ptrFloat(v)
			}
		}
	}

	if out, err := runCmd(syspath.Sysctl(), "-n", "kern.boottime"); err == nil {
		// kern.boottime output: "{ sec = 1234567890, usec = 0 }"
		s := string(out)
		if idx := strings.Index(s, "sec = "); idx >= 0 {
			sub := s[idx+6:]
			if end := strings.Index(sub, ","); end >= 0 {
				sub = sub[:end]
			}
			if bootSec, err := strconv.ParseInt(strings.TrimSpace(sub), 10, 64); err == nil {
				if up := time.Now().Unix() - bootSec; up >= 0 {
					m.UptimeSeconds = ptrInt64(up)
				}
			}
		}
	}

	return m, nil
}

func parseVMStat(data string) map[string]int64 {
	result := make(map[string]int64)
	for _, line := range strings.Split(data, "\n") {
		if strings.HasPrefix(line, "Mach Virtual Memory Statistics") {
			if idx := strings.Index(line, "page size of "); idx >= 0 {
				sub := line[idx+13:]
				if end := strings.Index(sub, " "); end >= 0 {
					sub = sub[:end]
				}
				if v, err := strconv.ParseInt(sub, 10, 64); err == nil {
					result["page_size"] = v
				}
			}
			continue
		}
		parts := strings.SplitN(line, ":", 2)
		if len(parts) != 2 {
			continue
		}
		key := strings.TrimSpace(parts[0])
		valStr := strings.TrimSpace(parts[1])
		valStr = strings.TrimSuffix(valStr, ".")
		if v, err := strconv.ParseInt(valStr, 10, 64); err == nil {
			result[key] = v
		}
	}
	return result
}

// parsePlistInt extracts <integer> following <key>key</key> in a basic XML plist.
func parsePlistInt(plist, key string) int64 {
	marker := "<key>" + key + "</key>"
	idx := strings.Index(plist, marker)
	if idx < 0 {
		return 0
	}
	rest := plist[idx+len(marker):]
	iStart := strings.Index(rest, "<integer>")
	if iStart < 0 {
		return 0
	}
	rest = rest[iStart+9:]
	iEnd := strings.Index(rest, "</integer>")
	if iEnd < 0 {
		return 0
	}
	v, err := strconv.ParseInt(strings.TrimSpace(rest[:iEnd]), 10, 64)
	if err != nil {
		return 0
	}
	return v
}

func readCPUPercent() (float64, error) {
	out, err := runCmd(syspath.PS(), "-A", "-o", "%cpu")
	if err != nil {
		return 0, err
	}
	var total float64
	for _, line := range strings.Split(string(out), "\n") {
		line = strings.TrimSpace(line)
		if v, err := strconv.ParseFloat(line, 64); err == nil {
			total += v
		}
	}
	if cpuOut, err := runCmd(syspath.Sysctl(), "-n", "hw.ncpu"); err == nil {
		if ncpu, err := strconv.ParseFloat(strings.TrimSpace(string(cpuOut)), 64); err == nil && ncpu > 0 {
			total = total / ncpu
		}
	}
	if total > 100 {
		total = 100
	}
	return total, nil
}
