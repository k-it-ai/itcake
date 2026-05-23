//go:build windows

package state

import (
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"syscall"
)

// errSharingViolation matches the Windows ERROR_SHARING_VIOLATION (32).
// Defined locally because the syscall package doesn't export it on every
// Windows toolchain version.
const errSharingViolation syscall.Errno = 32

// AcquireLock opens a lockfile with FILE_SHARE_NONE so a concurrent
// open from another process fails with ERROR_SHARING_VIOLATION. The
// handle holds the lock for the lifetime of the agent process; the
// returned closer releases it. On crash / SIGKILL, the kernel cleans
// up the handle and the next start can acquire fresh.
//
// Note: Go's os.O_EXCL is NOT what we want — that's "must create"
// semantics, not exclusive-share. We need a CreateFile that opens with
// dwShareMode=0.
func AcquireLock(stateDir string) (func(), error) {
	lockPath := filepath.Join(stateDir, "agent.lock")
	// Ensure the file exists so OPEN_ALWAYS doesn't behave differently.
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
		0, // dwShareMode = 0 → exclusive
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
	// Write our PID for operator forensics. Best-effort — not load-bearing.
	pidBuf := fmt.Sprintf("%d\r\n", os.Getpid())
	var written uint32
	_ = syscall.WriteFile(handle, []byte(pidBuf), &written, nil)
	return func() {
		_ = syscall.CloseHandle(handle)
	}, nil
}
