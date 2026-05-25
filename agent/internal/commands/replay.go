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

// MaxReplayCacheEntries hard-caps the cache. At cap, new IDs are refused
// rather than evicting old entries — eviction under HMAC-flooding would
// silently re-open the replay window for previously-seen genuine IDs.
const MaxReplayCacheEntries = 8192

// ReplayCache tracks command IDs that have been seen, blocking replay
// within the signature's validity window.
type ReplayCache struct {
	mu          sync.Mutex
	ttl         time.Duration
	m           map[string]time.Time
	persistPath string
	macKey      []byte
}

func NewReplayCache(ttl time.Duration) *ReplayCache {
	return &ReplayCache{ttl: ttl, m: make(map[string]time.Time)}
}

// NewPersistentReplayCache loads from path and atomically writes on every
// Check. macKey HMAC-tags the on-disk JSON so a planted `{}` is rejected
// on load.
func NewPersistentReplayCache(ttl time.Duration, path string, macKey []byte) *ReplayCache {
	rc := &ReplayCache{ttl: ttl, m: make(map[string]time.Time), persistPath: path, macKey: append([]byte(nil), macKey...)}
	rc.load()
	return rc
}

// Check returns true if id is fresh (record + persist); false on replay or cap.
func (r *ReplayCache) Check(id string) bool {
	r.mu.Lock()
	defer r.mu.Unlock()
	now := time.Now()
	if last, ok := r.m[id]; ok && now.Sub(last) < r.ttl {
		return false
	}
	if len(r.m) > 2048 {
		for k, t := range r.m {
			if now.Sub(t) > r.ttl {
				delete(r.m, k)
			}
		}
	}
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
		return
	}

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

	// Refuse legacy raw-map format — a planted file would bypass HMAC verification.
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
	// atomicfs fsyncs content before rename + parent dir after — a
	// power-loss flush gap could otherwise lose the cache and re-open
	// the replay window for captured signed commands.
	if err := atomicfs.WriteFile(r.persistPath, data, 0o600); err != nil {
		fmt.Fprintf(os.Stderr, "[replay] write failed: %v\n", err)
	}
}

func ReplayCachePath(configPath string) string {
	return filepath.Join(filepath.Dir(configPath), "replay-cache.json")
}
