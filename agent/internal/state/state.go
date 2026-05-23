// Package state writes a small JSON file next to the agent config that
// reports liveness for an external supervisor (LaunchDaemon, systemd,
// SCM watchdog scripts). Atomic writes via tmp+rename so a reader can
// never observe a half-written file. Read-modify-write means each call
// only updates the relevant fields — heartbeat updates don't clobber
// Status, status changes preserve LastHeartbeatAt, etc.
package state

import (
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"sync"
	"time"

	"github.com/itcake/agent/internal/atomicfs"
)

// ErrLockHeld is returned by AcquireLock when another live agent
// instance holds the per-config lockfile. The caller should refuse to
// start — running two instances racing on replay-cache.json,
// self-update, and config writes corrupts shared on-disk state.
var ErrLockHeld = errors.New("another agent instance is already running (lockfile held)")

// Status is the lifecycle phase recorded in the state file.
type Status string

const (
	StatusRunning  Status = "running"
	StatusStopping Status = "stopping"
	StatusStopped  Status = "stopped"
)

// State is the JSON payload of the on-disk state file.
type State struct {
	Status          Status    `json:"status"`
	PID             int       `json:"pid"`
	LastHeartbeatAt time.Time `json:"lastHeartbeatAt"`
	Version         string    `json:"version"`
}

// fileName is the on-disk filename written by PathInDir.
const fileName = "state.json"

// PathInDir returns the canonical state-file path for a given config
// directory. Equivalent to filepath.Join(dir, "state.json").
func PathInDir(dir string) string {
	return filepath.Join(dir, fileName)
}

// mu serialises concurrent writers in the same process. Cross-process
// safety isn't a goal — only one agent instance writes the file.
var mu sync.Mutex

// Read returns the parsed state file. A missing file yields the
// zero-value `Stopped` state with no error so callers can branch on
// the status without distinguishing missing from stopped. A corrupt
// JSON file returns the parse error so the caller can decide whether
// to overwrite or escalate.
func Read(path string) (*State, error) {
	data, err := os.ReadFile(path)
	if err != nil {
		if errors.Is(err, os.ErrNotExist) {
			return &State{Status: StatusStopped}, nil
		}
		return nil, fmt.Errorf("read state: %w", err)
	}
	var s State
	if err := json.Unmarshal(data, &s); err != nil {
		return nil, fmt.Errorf("parse state: %w", err)
	}
	return &s, nil
}

// readLocked is the inner read used while `mu` is already held by the
// caller's read-modify-write pair.
func readLocked(path string) (*State, error) {
	data, err := os.ReadFile(path)
	if err != nil {
		if errors.Is(err, os.ErrNotExist) {
			return &State{}, nil
		}
		return nil, fmt.Errorf("read state: %w", err)
	}
	var s State
	if err := json.Unmarshal(data, &s); err != nil {
		return nil, fmt.Errorf("parse state: %w", err)
	}
	return &s, nil
}

// writeAtomic renders `s` to JSON and replaces `path` atomically via
// tmp+rename. Mode 0644 — readable by an unprivileged supervisor
// process. Sensitive fields don't belong in this file.
func writeAtomic(path string, s *State) error {
	data, err := json.MarshalIndent(s, "", "  ")
	if err != nil {
		return fmt.Errorf("marshal state: %w", err)
	}
	// fsync the tmp file + the parent dir so a power loss between
	// rename and the next page-cache flush doesn't lose the heartbeat
	// (operator-visible "agent is up" signal).
	return atomicfs.WriteFile(path, data, 0o644)
}

// WriteRunning records that the agent is up. Called once at startup,
// after config load. Preserves LastHeartbeatAt if a previous run wrote
// it (so the supervisor doesn't see a fake "old" heartbeat get reset).
func WriteRunning(path, version string) error {
	mu.Lock()
	defer mu.Unlock()
	cur, err := readLocked(path)
	if err != nil {
		return err
	}
	cur.Status = StatusRunning
	cur.PID = os.Getpid()
	cur.Version = version
	return writeAtomic(path, cur)
}

// WriteStopping records that the agent received a stop signal and is
// winding down. Called from the SIGINT/SIGTERM handler before exit.
// Preserves Version + LastHeartbeatAt + PID.
func WriteStopping(path string) error {
	mu.Lock()
	defer mu.Unlock()
	cur, err := readLocked(path)
	if err != nil {
		return err
	}
	cur.Status = StatusStopping
	if cur.PID == 0 {
		cur.PID = os.Getpid()
	}
	return writeAtomic(path, cur)
}

// WriteHeartbeat updates only LastHeartbeatAt. Status/Version/PID are
// preserved so a stopping-then-still-heartbeating flow doesn't quietly
// flip the status back to running.
func WriteHeartbeat(path string) error {
	mu.Lock()
	defer mu.Unlock()
	cur, err := readLocked(path)
	if err != nil {
		return err
	}
	cur.LastHeartbeatAt = time.Now().UTC()
	if cur.PID == 0 {
		cur.PID = os.Getpid()
	}
	return writeAtomic(path, cur)
}
