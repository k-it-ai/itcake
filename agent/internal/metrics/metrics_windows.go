//go:build windows

package metrics

import (
	"os"
	"os/exec"
	"strings"
	"syscall"
	"time"
	"unsafe"

	"github.com/itcake/agent/internal/syspath"
	"golang.org/x/sys/windows"
)

// Collect gathers Windows system metrics via Win32 APIs (no PowerShell,
// no external binaries — minimises AV noise and child-process overhead).
func Collect() (*SystemMetrics, error) {
	m := &SystemMetrics{}

	if cpu, err := readCPUPercent(); err == nil {
		m.CPUPercent = ptrFloat(cpu)
	}
	if used, total, ok := readMemory(); ok {
		m.MemoryTotalBytes = ptrInt64(total)
		m.MemoryUsedBytes = ptrInt64(used)
	}
	if used, total, ok := readDisk(`C:\`); ok {
		m.DiskTotalBytes = ptrInt64(total)
		m.DiskUsedBytes = ptrInt64(used)
	}
	m.UptimeSeconds = ptrInt64(int64(readTickCount64() / 1000))

	reboot := rebootRequired()
	m.RebootRequired = &reboot

	return m, nil
}

var (
	kernel32            = windows.NewLazySystemDLL("kernel32.dll")
	procGetSystemTimes  = kernel32.NewProc("GetSystemTimes")
	procGlobalMemEx     = kernel32.NewProc("GlobalMemoryStatusEx")
	procGetDiskFreeSpEx = kernel32.NewProc("GetDiskFreeSpaceExW")
	procGetTickCount64  = kernel32.NewProc("GetTickCount64")
)

type filetime = syscall.Filetime

func getSystemTimes() (idle, kernel, user uint64, ok bool) {
	var it, kt, ut filetime
	r1, _, _ := procGetSystemTimes.Call(
		uintptr(unsafe.Pointer(&it)),
		uintptr(unsafe.Pointer(&kt)),
		uintptr(unsafe.Pointer(&ut)),
	)
	if r1 == 0 {
		return 0, 0, 0, false
	}
	toU64 := func(f filetime) uint64 { return (uint64(f.HighDateTime) << 32) | uint64(f.LowDateTime) }
	return toU64(it), toU64(kt), toU64(ut), true
}

func readCPUPercent() (float64, error) {
	i1, k1, u1, ok := getSystemTimes()
	if !ok {
		return 0, syscall.EINVAL
	}
	time.Sleep(500 * time.Millisecond)
	i2, k2, u2, ok := getSystemTimes()
	if !ok {
		return 0, syscall.EINVAL
	}
	idleDelta := i2 - i1
	// Kernel time includes idle on Windows; subtract idle to get active.
	kernelDelta := k2 - k1
	userDelta := u2 - u1
	total := kernelDelta + userDelta
	if total <= idleDelta {
		return 0, nil
	}
	active := total - idleDelta
	pct := float64(active) * 100.0 / float64(total)
	if pct < 0 {
		pct = 0
	}
	if pct > 100 {
		pct = 100
	}
	return pct, nil
}

type memoryStatusEx struct {
	Length               uint32
	MemoryLoad           uint32
	TotalPhys            uint64
	AvailPhys            uint64
	TotalPageFile        uint64
	AvailPageFile        uint64
	TotalVirtual         uint64
	AvailVirtual         uint64
	AvailExtendedVirtual uint64
}

func readMemory() (used, total int64, ok bool) {
	var ms memoryStatusEx
	ms.Length = uint32(unsafe.Sizeof(ms))
	r1, _, _ := procGlobalMemEx.Call(uintptr(unsafe.Pointer(&ms)))
	if r1 == 0 {
		return 0, 0, false
	}
	return int64(ms.TotalPhys - ms.AvailPhys), int64(ms.TotalPhys), true
}

func readDisk(root string) (used, total int64, ok bool) {
	p, err := syscall.UTF16PtrFromString(root)
	if err != nil {
		return 0, 0, false
	}
	var freeCaller, totalBytes, freeBytes uint64
	r1, _, _ := procGetDiskFreeSpEx.Call(
		uintptr(unsafe.Pointer(p)),
		uintptr(unsafe.Pointer(&freeCaller)),
		uintptr(unsafe.Pointer(&totalBytes)),
		uintptr(unsafe.Pointer(&freeBytes)),
	)
	if r1 == 0 {
		return 0, 0, false
	}
	return int64(totalBytes - freeBytes), int64(totalBytes), true
}

func readTickCount64() uint64 {
	ret, _, _ := procGetTickCount64.Call()
	return uint64(ret)
}

// rebootRequired checks the standard Windows pending-reboot indicators:
// CBS, Windows Update, PendingFileRenameOperations, and computer rename.
func rebootRequired() bool {
	keyIndicators := []string{
		`SOFTWARE\Microsoft\Windows\CurrentVersion\Component Based Servicing\RebootPending`,
		`SOFTWARE\Microsoft\Windows\CurrentVersion\Component Based Servicing\RebootInProgress`,
		`SOFTWARE\Microsoft\Windows\CurrentVersion\Component Based Servicing\PackagesPending`,
		`SOFTWARE\Microsoft\Windows\CurrentVersion\WindowsUpdate\Auto Update\RebootRequired`,
		`SOFTWARE\Microsoft\Windows\CurrentVersion\WindowsUpdate\Services\Pending`,
		`SOFTWARE\Microsoft\Windows\CurrentVersion\WindowsUpdate\PostRebootReporting`,
		`SOFTWARE\Microsoft\Updates\UpdateExeVolatile`,
	}
	for _, path := range keyIndicators {
		if regKeyExists(path) {
			return true
		}
	}
	if regMultiStringNonEmpty(`SYSTEM\CurrentControlSet\Control\Session Manager`, "PendingFileRenameOperations") {
		return true
	}
	active := regReadString(`SYSTEM\CurrentControlSet\Control\ComputerName\ActiveComputerName`, "ComputerName")
	pending := regReadString(`SYSTEM\CurrentControlSet\Control\ComputerName\ComputerName`, "ComputerName")
	if active != "" && pending != "" && active != pending {
		return true
	}
	return false
}

func regKeyExists(path string) bool {
	out, err := os.ReadFile(`\\?\Registry\Machine\` + path)
	_ = out
	if err == nil {
		return true
	}
	c := exec.Command(syspath.RegExe(), "query", `HKLM\`+path)
	if err := c.Run(); err == nil {
		return true
	}
	return false
}

func regReadString(path, name string) string {
	c := exec.Command(syspath.RegExe(), "query", `HKLM\`+path, "/v", name)
	out, err := c.Output()
	if err != nil {
		return ""
	}
	for _, line := range strings.Split(string(out), "\n") {
		if idx := strings.Index(line, "REG_SZ"); idx >= 0 {
			return strings.TrimSpace(line[idx+len("REG_SZ"):])
		}
	}
	return ""
}

func regMultiStringNonEmpty(path, name string) bool {
	c := exec.Command(syspath.RegExe(), "query", `HKLM\`+path, "/v", name)
	out, err := c.Output()
	if err != nil {
		return false
	}
	// REG_MULTI_SZ with only an empty separator means "no pending"; require
	// at least one non-space character after the type marker.
	for _, line := range strings.Split(string(out), "\n") {
		if strings.Contains(line, "REG_MULTI_SZ") {
			parts := strings.SplitN(line, "REG_MULTI_SZ", 2)
			if len(parts) == 2 && strings.TrimSpace(parts[1]) != "" {
				return true
			}
		}
	}
	return false
}
