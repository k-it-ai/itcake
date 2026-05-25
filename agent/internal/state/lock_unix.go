//go:build !windows

package state

import (
	"fmt"
	"os"
	"path/filepath"
	"syscall"
)

// AcquireLock takes an exclusive flock next to the state file. flock
// auto-releases on process exit, so a crashed previous instance unblocks
// the next start.
func AcquireLock(stateDir string) (func(), error) {
	lockPath := filepath.Join(stateDir, "agent.lock")
	f, err := os.OpenFile(lockPath, os.O_RDWR|os.O_CREATE, 0o600)
	if err != nil {
		return nil, fmt.Errorf("open lockfile: %w", err)
	}
	if err := syscall.Flock(int(f.Fd()), syscall.LOCK_EX|syscall.LOCK_NB); err != nil {
		_ = f.Close()
		if err == syscall.EWOULDBLOCK || err == syscall.EAGAIN {
			return nil, ErrLockHeld
		}
		return nil, fmt.Errorf("flock: %w", err)
	}
	// Record PID for operator forensics — flock itself is the truth.
	_ = f.Truncate(0)
	_, _ = f.Seek(0, 0)
	_, _ = fmt.Fprintf(f, "%d\n", os.Getpid())
	_ = f.Sync()
	return func() {
		_ = syscall.Flock(int(f.Fd()), syscall.LOCK_UN)
		_ = f.Close()
	}, nil
}
