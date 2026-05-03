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
// within the signature's validity window. When persistPath is set,
// state survives process restart.
type ReplayCache struct {
	mu          sync.Mutex
	ttl         time.Duration
	m           map[string]time.Time
	persistPath string
}

func NewReplayCache(ttl time.Duration) *ReplayCache {
	return &ReplayCache{ttl: ttl, m: make(map[string]time.Time)}
}

// NewPersistentReplayCache loads from path on construction and
// atomically writes on every Check. Load/save failures are
// non-fatal (a corrupt or missing file just resets the cache).
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
	// os.WriteFile honors the umask; with default 022 the file lands at 0o644
	// until the next EnsureLockdown run. Force 0o600 explicitly so command-id
	// timing/ordering doesn't leak to local non-root users between writes.
	// (Windows: chmod is silently ignored — config dir ACL covers it.)
	if err := os.Chmod(tmp, 0o600); err != nil {
		fmt.Fprintf(os.Stderr, "[replay] chmod failed: %v\n", err)
	}
	if err := os.Rename(tmp, r.persistPath); err != nil {
		_ = os.Remove(tmp)
		fmt.Fprintf(os.Stderr, "[replay] rename failed: %v\n", err)
	}
}

func ReplayCachePath(configPath string) string {
	return filepath.Join(filepath.Dir(configPath), "replay-cache.json")
}
