//go:build windows

package eventlog

import (
	"context"
	"encoding/xml"
	"fmt"
	"os/exec"
	"strings"
	"time"

	"github.com/itcake/agent/internal/syspath"
)

// collect pulls Critical/Error/Warning from System + Application via wevtutil.
func collect() []Event {
	system := query("System")
	application := query("Application")
	combined := append(system, application...)
	if len(combined) > MaxEvents {
		combined = combined[:MaxEvents]
	}
	return combined
}

func query(channel string) []Event {
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()

	xpath := fmt.Sprintf(
		`*[System[(Level=1 or Level=2 or Level=3) and TimeCreated[timediff(@SystemTime) <= %d]]]`,
		LookbackMinutes*60*1000,
	)
	args := []string{
		"qe", channel,
		"/q:" + xpath,
		"/c:" + fmt.Sprintf("%d", MaxEvents),
		"/rd:true",
		"/f:xml",
		"/e:Events",
	}
	out, err := exec.CommandContext(ctx, syspath.Wevtutil(), args...).Output()
	if err != nil {
		return nil
	}

	type evt struct {
		System struct {
			Provider struct {
				Name string `xml:"Name,attr"`
			} `xml:"Provider"`
			Level       int    `xml:"Level"`
			EventID     int    `xml:"EventID"`
			TimeCreated struct {
				SystemTime string `xml:"SystemTime,attr"`
			} `xml:"TimeCreated"`
			Channel string `xml:"Channel"`
		} `xml:"System"`
		EventData struct {
			Data []string `xml:"Data"`
		} `xml:"EventData"`
	}
	type wrap struct {
		Events []evt `xml:"Event"`
	}

	var w wrap
	if err := xml.Unmarshal(out, &w); err != nil {
		return nil
	}

	events := make([]Event, 0, len(w.Events))
	for _, e := range w.Events {
		level := mapWindowsLevel(e.System.Level)
		if level == "" {
			continue
		}
		message := strings.Join(e.EventData.Data, " | ")
		if message == "" {
			message = fmt.Sprintf("Event ID %d", e.System.EventID)
		}
		events = append(events, Event{
			Level:      level,
			Source:     e.System.Provider.Name,
			Message:    truncate(message),
			OccurredAt: e.System.TimeCreated.SystemTime,
		})
	}
	return events
}

func mapWindowsLevel(l int) string {
	switch l {
	case 1:
		return "critical"
	case 2:
		return "error"
	case 3:
		return "warning"
	}
	return ""
}
