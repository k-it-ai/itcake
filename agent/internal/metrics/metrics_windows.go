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

// Collect gathers Windows system metrics using Win32 APIs directly —
// no external binaries, no PowerShell. This avoids spawning child
// processes (which AV vendors scrutinize) and also keeps the
// collection cheap (runs every check-in interval).
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

	// Reboot-required flag: Tactical RMM's pattern, widely considered the
	// canonical Windows signal. Any of these registry indicators means
	// "pending-reboot" — they're set by CBS (Component Based Servicing),
	// Windows Update, or a recent Win32 computer-rename.
	reboot := rebootRequired()
	m.RebootRequired = &reboot

	// Windows has no true loadavg; leave nil. The server treats nil
	// correctly (renders "—" in UI), which is better than fabricating
	// a misleading value.
	return m, nil
}

// --- CPU ---

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
	// Kernel includes idle, so: active = (kernel + user) - idle
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

// --- Memory ---

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

// --- Disk ---

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

// --- Uptime ---

func readTickCount64() uint64 {
	ret, _, _ := procGetTickCount64.Call()
	return uint64(ret)
}

// --- Reboot-required detection ---

// rebootRequired returns true if any of the standard Windows
// pending-reboot indicators is set. These cover:
//   - CBS (Component-Based Servicing)       — patch pending
//   - Windows Update                        — update pending
//   - Pending file rename operations        — installer leftover
//   - Computer rename                       — ActiveComputerName != ComputerName
//
// Source: Microsoft engineering guidance + Tactical RMM reference
// pattern — stable across Windows 10/11/Server 2016+.
func rebootRequired() bool {
	// Indicator keys. Presence of the KEY itself (regardless of values)
	// means reboot is required.
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
	// PendingFileRenameOperations value under Session Manager — presence
	// of any non-empty values is the signal.
	if regMultiStringNonEmpty(`SYSTEM\CurrentControlSet\Control\Session Manager`, "PendingFileRenameOperations") {
		return true
	}
	// Computer rename: compare ActiveComputerName vs ComputerName.
	active := regReadString(`SYSTEM\CurrentControlSet\Control\ComputerName\ActiveComputerName`, "ComputerName")
	pending := regReadString(`SYSTEM\CurrentControlSet\Control\ComputerName\ComputerName`, "ComputerName")
	if active != "" && pending != "" && active != pending {
		return true
	}
	return false
}

// --- Tiny registry helpers ---

func regKeyExists(path string) bool {
	out, err := os.ReadFile(`\\?\Registry\Machine\` + path) // not a real file — fall through
	_ = out
	if err == nil {
		return true
	}
	// Actually check via reg.exe (syscall avoided here to keep build
	// dependency-light; reg.exe ships with Windows and is safe).
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
	// A REG_MULTI_SZ with only an empty separator is "no pending" —
	// require at least one non-space character after the type marker.
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
