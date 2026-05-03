package commands

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"sync"
	"time"
)

// ReplayCache tracks command IDs that have been seen, blocking replay
// even within the signature's validity window.
//
// Entries expire after `ttl` (set to > max signature age) so the set
// doesn't grow unbounded over the lifetime of the agent.
//
// When `persistPath` is non-empty, the cache is loaded from disk on
// construction and atomically written on every Check. Without
// persistence, an agent restart inside the ±10 min replay window lets
// a captured signed command fire again — service-manager-induced
// restarts are common (crash, package upgrade, manual restart), so the
// in-RAM-only variant was reliably bypassable in production.
type ReplayCache struct {
	mu          sync.Mutex
	ttl         time.Duration
	m           map[string]time.Time
	persistPath string
}

func NewReplayCache(ttl time.Duration) *ReplayCache {
	return &ReplayCache{ttl: ttl, m: make(map[string]time.Time)}
}

// NewPersistentReplayCache returns a cache that survives process
// restart by serializing to `path`. Load failures are non-fatal — we
// fail open on the first run if the file is missing or corrupt, which
// is the same as starting fresh. Save failures log but do not block
// the command path.
func NewPersistentReplayCache(ttl time.Duration, path string) *ReplayCache {
	rc := &ReplayCache{ttl: ttl, m: make(map[string]time.Time), persistPath: path}
	rc.load()
	return rc
}

// Check returns true if `id` has NOT been seen within ttl — on true the
// caller may process the command, and id is recorded as seen. Returns
// false on duplicate.
func (r *ReplayCache) Check(id string) bool {
	r.mu.Lock()
	defer r.mu.Unlock()
	now := time.Now()
	if last, ok := r.m[id]; ok && now.Sub(last) < r.ttl {
		return false
	}
	// Opportunistic prune — cheap since we're already holding the lock.
	if len(r.m) > 2048 {
		for k, t := range r.m {
			if now.Sub(t) > r.ttl {
				delete(r.m, k)
			}
		}
	}
	r.m[id] = now
	r.persistLocked()
	return true
}

func (r *ReplayCache) load() {
	if r.persistPath == "" {
		return
	}
	data, err := os.ReadFile(r.persistPath)
	if err != nil {
		return // fresh cache; first run or fresh install
	}
	var m map[string]time.Time
	if err := json.Unmarshal(data, &m); err != nil {
		return
	}
	now := time.Now()
	for k, t := range m {
		if now.Sub(t) < r.ttl {
			r.m[k] = t
		}
	}
}

func (r *ReplayCache) persistLocked() {
	if r.persistPath == "" {
		return
	}
	data, err := json.Marshal(r.m)
	if err != nil {
		fmt.Fprintf(os.Stderr, "[replay] marshal failed: %v\n", err)
		return
	}
	tmp := r.persistPath + ".tmp"
	if err := os.WriteFile(tmp, data, 0o600); err != nil {
		fmt.Fprintf(os.Stderr, "[replay] write failed: %v\n", err)
		return
	}
	if err := os.Rename(tmp, r.persistPath); err != nil {
		_ = os.Remove(tmp)
		fmt.Fprintf(os.Stderr, "[replay] rename failed: %v\n", err)
	}
}

// ReplayCachePath returns the agent's persistent replay-cache path,
// alongside the encrypted config. Lockdown semantics inherit from the
// parent dir (Save() already calls lockdownPath on Windows).
func ReplayCachePath(configPath string) string {
	return filepath.Join(filepath.Dir(configPath), "replay-cache.json")
}
