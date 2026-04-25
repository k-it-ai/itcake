//go:build darwin

package eventlog

import (
	"context"
	"encoding/json"
	"fmt"
	"os/exec"
	"strings"
	"time"
)

// macOS: `log show --last <X>m --predicate 'messageType >= 16' --style ndjson`
// returns one JSON object per line. messageType 16 = error, 17 = fault.
// We promote `default`-level messages with `category` = error/fault to error.
func collect() []Event {
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()

	args := []string{
		"show",
		"--last", fmt.Sprintf("%dm", LookbackMinutes),
		"--predicate", "messageType >= 16",
		"--style", "ndjson",
	}
	out, err := exec.CommandContext(ctx, "log", args...).Output()
	if err != nil {
		return nil
	}

	var events []Event
	for _, line := range strings.Split(string(out), "\n") {
		line = strings.TrimSpace(line)
		if line == "" || !strings.HasPrefix(line, "{") {
			continue
		}
		var rec struct {
			Timestamp     string `json:"timestamp"`
			MessageType   string `json:"messageType"`
			Subsystem     string `json:"subsystem"`
			Category      string `json:"category"`
			ProcessImagePath string `json:"processImagePath"`
			EventMessage  string `json:"eventMessage"`
		}
		if err := json.Unmarshal([]byte(line), &rec); err != nil {
			continue
		}
		level := mapMessageType(rec.MessageType)
		if level == "" {
			continue
		}
		source := rec.Subsystem
		if source == "" {
			source = baseName(rec.ProcessImagePath)
		}
		events = append(events, Event{
			Level:      level,
			Source:     source,
			Message:    truncate(rec.EventMessage),
			OccurredAt: rec.Timestamp,
		})
		if len(events) >= MaxEvents {
			break
		}
	}
	return events
}

func mapMessageType(t string) string {
	switch t {
	case "Fault":
		return "critical"
	case "Error":
		return "error"
	}
	return ""
}

func baseName(p string) string {
	if p == "" {
		return ""
	}
	if i := strings.LastIndex(p, "/"); i >= 0 {
		return p[i+1:]
	}
	return p
}
