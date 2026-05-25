//go:build windows

package state

import (
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"syscall"
)

// errSharingViolation = ERROR_SHARING_VIOLATION (32); not exported by the
// syscall package on every Go toolchain.
const errSharingViolation syscall.Errno = 32

// AcquireLock opens lockfile with dwShareMode=0 (exclusive). Note: Go's
// os.O_EXCL is "must create" semantics, not exclusive-share — we need
// raw CreateFile.
func AcquireLock(stateDir string) (func(), error) {
	lockPath := filepath.Join(stateDir, "agent.lock")
	if _, err := os.Stat(lockPath); os.IsNotExist(err) {
		f, err := os.Create(lockPath)
		if err != nil {
			return nil, fmt.Errorf("create lockfile: %w", err)
		}
		_ = f.Close()
	}
	pathPtr, err := syscall.UTF16PtrFromString(lockPath)
	if err != nil {
		return nil, fmt.Errorf("path: %w", err)
	}
	handle, err := syscall.CreateFile(
		pathPtr,
		syscall.GENERIC_READ|syscall.GENERIC_WRITE,
		0,
		nil,
		syscall.OPEN_EXISTING,
		syscall.FILE_ATTRIBUTE_NORMAL,
		0,
	)
	if err != nil {
		if errors.Is(err, errSharingViolation) {
			return nil, ErrLockHeld
		}
		return nil, fmt.Errorf("CreateFile: %w", err)
	}
	pidBuf := fmt.Sprintf("%d\r\n", os.Getpid())
	var written uint32
	_ = syscall.WriteFile(handle, []byte(pidBuf), &written, nil)
	return func() {
		_ = syscall.CloseHandle(handle)
	}, nil
}
