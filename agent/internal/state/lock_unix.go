//go:build !windows

package state

import (
	"fmt"
	"os"
	"path/filepath"
	"syscall"
)

// AcquireLock takes an exclusive flock on a lockfile next to the state
// file. On success the returned closer releases the lock — defer it for
// the lifetime of the agent process. If another live instance already
// holds the lock, returns ErrLockHeld so the caller can refuse to start
// (rather than racing on replay-cache, self-update, and config writes).
//
// flock auto-releases when the process exits (crash, SIGKILL, normal
// exit), so a crashed previous instance does NOT block the next start.
func AcquireLock(stateDir string) (func(), error) {
	lockPath := filepath.Join(stateDir, "agent.lock")
	f, err := os.OpenFile(lockPath, os.O_RDWR|os.O_CREATE, 0o600)
	if err != nil {
		return nil, fmt.Errorf("open lockfile: %w", err)
	}
	// LOCK_NB → return immediately if held. LOCK_EX → exclusive lock.
	if err := syscall.Flock(int(f.Fd()), syscall.LOCK_EX|syscall.LOCK_NB); err != nil {
		_ = f.Close()
		if err == syscall.EWOULDBLOCK || err == syscall.EAGAIN {
			return nil, ErrLockHeld
		}
		return nil, fmt.Errorf("flock: %w", err)
	}
	// Record our PID inside the lockfile for operator forensics. Not
	// load-bearing — flock IS the truth — but a quick `cat agent.lock`
	// tells the operator which PID currently owns the agent.
	_ = f.Truncate(0)
	_, _ = f.Seek(0, 0)
	_, _ = fmt.Fprintf(f, "%d\n", os.Getpid())
	_ = f.Sync()
	return func() {
		_ = syscall.Flock(int(f.Fd()), syscall.LOCK_UN)
		_ = f.Close()
	}, nil
}
