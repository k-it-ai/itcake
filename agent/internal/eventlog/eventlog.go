// Package eventlog collects recent error/warning events from the host's
// system log (journalctl on Linux, `log show` on macOS, Event Log on
// Windows) and ships them up with the periodic check-in.
//
// Output is intentionally low-volume: at most `MaxEvents` per cycle, only
// `error` / `warning` / `critical` levels, capped to a single message line
// of `MaxMessageLength`. Operators get a "needs attention" feed without
// drowning the server in routine info-level chatter.
package eventlog

const (
	// Time window for the lookback. Should align with the check-in cadence
	// so we don't miss events between cycles, but not so long that we
	// flood the server on first contact. 15 min is a comfortable middle.
	LookbackMinutes = 15
	MaxEvents       = 50
	MaxMessageLen   = 500
)

// Event is the on-the-wire shape sent to the server in the check-in payload.
type Event struct {
	Level      string `json:"level"`      // "critical" | "error" | "warning"
	Source     string `json:"source"`     // unit / process name / log channel
	Message    string `json:"message"`    // single-line, truncated to MaxMessageLen
	OccurredAt string `json:"occurredAt"` // RFC3339
}

// Collect returns recent error/warning events from the OS log.
// Implementations are per-platform (eventlog_linux.go etc.) and best-effort:
// they return an empty slice (not an error) if the underlying tool is
// missing, so the agent never breaks check-in due to a log-collection issue.
func Collect() []Event {
	return collect()
}

func truncate(s string) string {
	if len(s) > MaxMessageLen {
		return s[:MaxMessageLen]
	}
	return s
}
