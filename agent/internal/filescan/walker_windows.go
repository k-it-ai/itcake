//go:build windows

package filescan

import (
	"strings"
	"syscall"
	"unsafe"
)

var (
	kernel32         = syscall.NewLazyDLL("kernel32.dll")
	procGetDriveType = kernel32.NewProc("GetDriveTypeW")
)

const driveRemote = 4

// platformIsNetworkMount on Windows checks the drive letter via
// GetDriveTypeW. Best-effort: paths inside a remote-mount junction may
// still walk; deeper inspection would require GetVolumeInformationW
// per directory and isn't worth the syscall cost.
func platformIsNetworkMount(dir string) bool {
	if len(dir) < 2 || dir[1] != ':' {
		return false
	}
	root := strings.ToUpper(string(dir[0])) + `:\`
	rootPtr, err := syscall.UTF16PtrFromString(root)
	if err != nil {
		return false
	}
	r1, _, _ := procGetDriveType.Call(uintptr(unsafe.Pointer(rootPtr)))
	return uint32(r1) == driveRemote
}
