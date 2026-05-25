// Package state writes a liveness JSON file next to the agent config for
// external supervisors. Atomic tmp+rename + read-modify-write means each
// call only updates the relevant fields.
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

// ErrLockHeld is returned when another live agent holds the lockfile —
// two instances would race on replay-cache, self-update, and config writes.
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

const fileName = "state.json"

// PathInDir returns dir/state.json.
func PathInDir(dir string) string {
	return filepath.Join(dir, fileName)
}

var mu sync.Mutex

// Read returns the parsed state. Missing file → zero-value Stopped state.
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

// writeAtomic JSON-encodes s and atomically replaces path. Mode 0644 so
// an unprivileged supervisor can read; no sensitive fields.
func writeAtomic(path string, s *State) error {
	data, err := json.MarshalIndent(s, "", "  ")
	if err != nil {
		return fmt.Errorf("marshal state: %w", err)
	}
	return atomicfs.WriteFile(path, data, 0o644)
}

// WriteRunning records that the agent is up.
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

// WriteStopping records that the agent is winding down on a stop signal.
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

// WriteHeartbeat updates only LastHeartbeatAt; preserves status/version/pid.
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
