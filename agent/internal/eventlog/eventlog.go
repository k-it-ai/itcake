// Package eventlog collects recent error/warning events from the host system
// log and ships them with the periodic check-in. Output is capped at
// MaxEvents per cycle, error/warning/critical only.
package eventlog

const (
	LookbackMinutes = 15
	MaxEvents       = 50
	MaxMessageLen   = 500
)

// Event is the on-the-wire shape sent to the server in the check-in payload.
type Event struct {
	Level      string `json:"level"`
	Source     string `json:"source"`
	Message    string `json:"message"`
	OccurredAt string `json:"occurredAt"`
}

// Collect returns recent error/warning events from the OS log. Best-effort —
// returns empty (not error) when the underlying tool is missing.
func Collect() []Event {
	return collect()
}

func truncate(s string) string {
	if len(s) > MaxMessageLen {
		return s[:MaxMessageLen]
	}
	return s
}
