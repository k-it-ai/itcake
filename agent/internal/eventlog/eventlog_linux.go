//go:build linux

package eventlog

import (
	"context"
	"encoding/json"
	"fmt"
	"os/exec"
	"strconv"
	"strings"
	"time"

	"github.com/itcake/agent/internal/syspath"
)

// collect pulls warning+ events from systemd-journal.
func collect() []Event {
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()

	since := fmt.Sprintf("%d minutes ago", LookbackMinutes)
	args := []string{
		"-p", "warning",
		"-S", since,
		"--no-pager",
		"-o", "json",
		"-n", strconv.Itoa(MaxEvents),
	}
	out, err := exec.CommandContext(ctx, syspath.Journalctl(), args...).Output()
	if err != nil {
		return nil
	}

	var events []Event
	for _, line := range strings.Split(string(out), "\n") {
		line = strings.TrimSpace(line)
		if line == "" {
			continue
		}
		var rec map[string]interface{}
		if err := json.Unmarshal([]byte(line), &rec); err != nil {
			continue
		}

		level := mapPriority(rec["PRIORITY"])
		if level == "" {
			continue
		}
		source := stringField(rec, "_SYSTEMD_UNIT", "SYSLOG_IDENTIFIER", "_COMM")
		message := stringField(rec, "MESSAGE")
		occurredAt := parseJournalTimestamp(rec)

		events = append(events, Event{
			Level:      level,
			Source:     source,
			Message:    truncate(message),
			OccurredAt: occurredAt,
		})
		if len(events) >= MaxEvents {
			break
		}
	}
	return events
}

// mapPriority converts syslog severity (0=emerg .. 7=debug) to our buckets.
func mapPriority(v interface{}) string {
	s, ok := v.(string)
	if !ok {
		return ""
	}
	switch s {
	case "0", "1", "2":
		return "critical"
	case "3":
		return "error"
	case "4":
		return "warning"
	}
	return ""
}

func stringField(rec map[string]interface{}, keys ...string) string {
	for _, k := range keys {
		if v, ok := rec[k].(string); ok && v != "" {
			return v
		}
	}
	return ""
}

func parseJournalTimestamp(rec map[string]interface{}) string {
	for _, k := range []string{"_SOURCE_REALTIME_TIMESTAMP", "__REALTIME_TIMESTAMP"} {
		if v, ok := rec[k].(string); ok && v != "" {
			us, err := strconv.ParseInt(v, 10, 64)
			if err == nil {
				return time.UnixMicro(us).UTC().Format(time.RFC3339)
			}
		}
	}
	return time.Now().UTC().Format(time.RFC3339)
}
