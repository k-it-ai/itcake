package commands

import (
	"sync"
	"time"
)

// ReplayCache tracks command IDs that have been seen, blocking replay
// even within the signature's validity window.
//
// Entries expire after `ttl` (set to > max signature age) so the set
// doesn't grow unbounded over the lifetime of the agent.
type ReplayCache struct {
	mu  sync.Mutex
	ttl time.Duration
	m   map[string]time.Time
}

func NewReplayCache(ttl time.Duration) *ReplayCache {
	return &ReplayCache{ttl: ttl, m: make(map[string]time.Time)}
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
	return true
}
