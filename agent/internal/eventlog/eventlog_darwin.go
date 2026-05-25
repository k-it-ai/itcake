//go:build darwin

package eventlog

import (
	"bufio"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"os/exec"
	"strings"
	"time"

	"github.com/itcake/agent/internal/syspath"
)

// collect runs `log show --predicate 'messageType >= 16' --style ndjson`
// (16 = error, 17 = fault).
func collect() []Event {
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()

	args := []string{
		"show",
		"--last", fmt.Sprintf("%dm", LookbackMinutes),
		"--predicate", "messageType >= 16",
		"--style", "ndjson",
	}
	cmd := exec.CommandContext(ctx, syspath.Logd(), args...)
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		return nil
	}
	if err := cmd.Start(); err != nil {
		return nil
	}
	defer func() { _ = cmd.Wait() }()

	const maxStreamBytes = 16 << 20
	const maxLineBytes = 1 << 20
	scanner := bufio.NewScanner(io.LimitReader(stdout, maxStreamBytes))
	scanner.Buffer(make([]byte, 0, 64<<10), maxLineBytes)

	var events []Event
	for scanner.Scan() {
		line := strings.TrimSpace(scanner.Text())
		if line == "" || !strings.HasPrefix(line, "{") {
			continue
		}
		var rec struct {
			Timestamp        string `json:"timestamp"`
			MessageType      string `json:"messageType"`
			Subsystem        string `json:"subsystem"`
			Category         string `json:"category"`
			ProcessImagePath string `json:"processImagePath"`
			EventMessage     string `json:"eventMessage"`
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
	_, _ = io.Copy(io.Discard, stdout)
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
