package commands

import (
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"sync"
	"time"

	"github.com/itcake/agent/internal/atomicfs"
)

// MaxReplayCacheEntries hard-caps the in-memory map and the on-disk JSON.
// At 60s checkin cadence with 100 commands/min that's enough headroom for
// >80 minutes of unique-id traffic before forced eviction; if the server
// pumps faster, the oldest entries are evicted to keep the cache bounded.
// Without this cap a compromised server with valid HMAC could grow the
// cache until OOM.
const MaxReplayCacheEntries = 8192

// ReplayCache tracks command IDs that have been seen, blocking replay
// within the signature's validity window. When persistPath is set,
// state survives process restart.
type ReplayCache struct {
	mu          sync.Mutex
	ttl         time.Duration
	m           map[string]time.Time
	persistPath string
	macKey      []byte // optional — if set, the on-disk file is HMAC-tagged
}

func NewReplayCache(ttl time.Duration) *ReplayCache {
	return &ReplayCache{ttl: ttl, m: make(map[string]time.Time)}
}

// NewPersistentReplayCache loads from path on construction and atomically
// writes on every Check. Load/save failures are non-fatal (a corrupt or
// missing file just resets the cache).
//
// macKey, when non-empty, MACs the on-disk JSON with HMAC-SHA256. A
// tampered file (a local user with brief write access plants `{}` to
// erase replay protection) is then detected and rejected on load — the
// cache resets, but the agent logs loudly so the operator sees it.
func NewPersistentReplayCache(ttl time.Duration, path string, macKey []byte) *ReplayCache {
	rc := &ReplayCache{ttl: ttl, m: make(map[string]time.Time), persistPath: path, macKey: append([]byte(nil), macKey...)}
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
	// Hard cap: if even after the TTL prune we're at the ceiling,
	// REFUSE the new entry. Previous behaviour evicted the oldest 25%
	// which silently weakened replay protection — an HMAC-holding
	// compromised server could flood the cache, force eviction of
	// genuine ID slots, then replay against them within the 30-min
	// freshness window. A refused new entry surfaces as a failed
	// command rather than a quietly-accepted replay.
	if len(r.m) >= MaxReplayCacheEntries {
		fmt.Fprintf(os.Stderr, "[replay] cache at cap (%d); refusing new id %s — investigate flood\n", MaxReplayCacheEntries, id)
		return false
	}
	r.m[id] = now
	r.persistLocked()
	return true
}

type persistedReplayCache struct {
	Entries map[string]time.Time `json:"entries"`
	MAC     string               `json:"mac,omitempty"`
}

func (r *ReplayCache) computeMAC(entriesJSON []byte) string {
	if len(r.macKey) == 0 {
		return ""
	}
	mac := hmac.New(sha256.New, r.macKey)
	mac.Write(entriesJSON)
	return hex.EncodeToString(mac.Sum(nil))
}

func (r *ReplayCache) load() {
	if r.persistPath == "" {
		return
	}
	data, err := os.ReadFile(r.persistPath)
	if err != nil {
		return // fresh cache; first run or fresh install
	}

	// Try the new wrapped format first.
	var wrapped persistedReplayCache
	if err := json.Unmarshal(data, &wrapped); err == nil && wrapped.Entries != nil {
		if len(r.macKey) > 0 {
			entriesJSON, err := json.Marshal(wrapped.Entries)
			if err != nil {
				fmt.Fprintf(os.Stderr, "[replay] HMAC validation skipped: marshal failed\n")
				return
			}
			expected := r.computeMAC(entriesJSON)
			if !hmac.Equal([]byte(expected), []byte(wrapped.MAC)) {
				fmt.Fprintf(os.Stderr, "[replay] WARNING: cache HMAC mismatch — possible tamper. Resetting cache.\n")
				return
			}
		}
		now := time.Now()
		for k, t := range wrapped.Entries {
			if now.Sub(t) < r.ttl {
				r.m[k] = t
			}
		}
		return
	}

	// Legacy raw-map format used to be accepted as a one-shot upgrade path,
	// but a local user with brief filesystem write to the cache could plant
	// a raw-map JSON to bypass HMAC verification. Refuse legacy files: a
	// fresh start costs at most one replay-window's worth of protection on
	// the upgrade transition, which is acceptable.
	if len(data) > 0 {
		fmt.Fprintf(os.Stderr, "[replay] WARNING: cache file in unsupported (legacy or invalid) format; refusing to load. Cache will be rebuilt on next signed command.\n")
	}
}

func (r *ReplayCache) persistLocked() {
	if r.persistPath == "" {
		return
	}
	entriesJSON, err := json.Marshal(r.m)
	if err != nil {
		fmt.Fprintf(os.Stderr, "[replay] marshal failed: %v\n", err)
		return
	}
	wrapped := persistedReplayCache{Entries: r.m, MAC: r.computeMAC(entriesJSON)}
	data, err := json.Marshal(wrapped)
	if err != nil {
		fmt.Fprintf(os.Stderr, "[replay] marshal failed: %v\n", err)
		return
	}
	// Use atomicfs so the file content is fsync'd to disk BEFORE the
	// rename, and the parent directory is fsync'd AFTER. Without this,
	// a power loss between write+rename and the next page-cache flush
	// could lose the replay cache entirely — re-opening the 30-min
	// replay window for any captured signed command.
	if err := atomicfs.WriteFile(r.persistPath, data, 0o600); err != nil {
		fmt.Fprintf(os.Stderr, "[replay] write failed: %v\n", err)
	}
}

func ReplayCachePath(configPath string) string {
	return filepath.Join(filepath.Dir(configPath), "replay-cache.json")
}
