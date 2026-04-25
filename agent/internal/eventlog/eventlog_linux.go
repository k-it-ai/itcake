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
)

// Linux: pull from systemd-journal via `journalctl -p err -S "<duration> ago"
// --no-pager -o json -n <max>`. Each line is a JSON object — we map the
// PRIORITY (syslog level) into our 3-bucket level taxonomy.
func collect() []Event {
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()

	since := fmt.Sprintf("%d minutes ago", LookbackMinutes)
	args := []string{
		"-p", "warning", // includes warning AND higher (err, crit, alert, emerg)
		"-S", since,
		"--no-pager",
		"-o", "json",
		"-n", strconv.Itoa(MaxEvents),
	}
	out, err := exec.CommandContext(ctx, "journalctl", args...).Output()
	if err != nil {
		return nil // journalctl missing or failed — skip silently
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
		// _SOURCE_REALTIME_TIMESTAMP / __REALTIME_TIMESTAMP are µs since epoch
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

// mapPriority converts syslog severity (0-7) to our coarse buckets. Anything
// at warning (4) or higher (lower number) is reported. Below that we drop.
func mapPriority(v interface{}) string {
	s, ok := v.(string)
	if !ok {
		return ""
	}
	switch s {
	case "0", "1", "2": // emerg, alert, crit
		return "critical"
	case "3": // err
		return "error"
	case "4": // warning
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
