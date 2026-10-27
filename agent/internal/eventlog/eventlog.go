// Package eventlog collects recent error/warning events from the host system
// log and ships them with the periodic check-in. Output is capped at
// MaxEvents per cycle, error/warning/critical only.
package eventlog

import (
	"sync/atomic"
	"time"
)

const (
	LookbackMinutes = 15
	MaxEvents       = 50
	MaxMessageLen   = 500

	// collectBudget is the hard wall-clock limit for one collection. The
	// per-platform commands already carry contexts, but a stuck child can
	// hold its stdout pipe open past the context deadline (e.g. macOS `log
	// show` in an uninterruptible kernel wait). The check-in loop must never
	// block on log collection: an agent that stops checking in looks offline
	// and cannot receive commands. On timeout we return nil and let the
	// single-flight guard suppress further attempts until the stuck call
	// finishes.
	collectBudget = 10 * time.Second
)

var collecting atomic.Bool

// Event is the on-the-wire shape sent to the server in the check-in payload.
type Event struct {
	Level      string `json:"level"`
	Source     string `json:"source"`
	Message    string `json:"message"`
	OccurredAt string `json:"occurredAt"`
}

// Collect returns recent error/warning events from the OS log. Best-effort —
// returns empty (not error) when the underlying tool is missing.
//
// Collection is bounded by collectBudget and a single-flight guard. A hung
// `log show` / `journalctl` / `wevtutil` must never stall the check-in loop:
// an agent that stops checking in looks offline and cannot receive commands.
// On timeout we return nil and let the guard suppress further attempts until
// the stuck call finishes.
func Collect() []Event {
	if !collecting.CompareAndSwap(false, true) {
		return nil
	}
	ch := make(chan []Event, 1)
	go func() {
		defer collecting.Store(false)
		ch <- collect()
	}()
	select {
	case events := <-ch:
		return events
	case <-time.After(collectBudget):
		return nil
	}
}

func truncate(s string) string {
	if len(s) > MaxMessageLen {
		return s[:MaxMessageLen]
	}
	return s
}
