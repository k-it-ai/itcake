//go:build windows

package bootperf

import (
	"context"
	"encoding/xml"
	"os/exec"
	"strconv"
	"strings"
	"syscall"
	"time"

	"github.com/itcake/agent/internal/syspath"
)

// Windows exposes phase timing via Microsoft-Windows-Diagnostics-Performance/Operational
// Event ID 100. We pull the most recent record via PowerShell, parse the XML,
// and map BootTime / MainPathBootTime / BootPostBootTime.

type winEvent struct {
	XMLName    xml.Name `xml:"Event"`
	System     struct {
		TimeCreated struct {
			SystemTime string `xml:"SystemTime,attr"`
		} `xml:"TimeCreated"`
	} `xml:"System"`
	EventData struct {
		Data []struct {
			Name  string `xml:"Name,attr"`
			Value string `xml:",chardata"`
		} `xml:"Data"`
	} `xml:"EventData"`
}

func collect() Metrics {
	out := Metrics{Source: "Diagnostics-Performance/100"}
	ctx, cancel := context.WithTimeout(context.Background(), 12*time.Second)
	defer cancel()

	script := `Get-WinEvent -FilterHashtable @{LogName='Microsoft-Windows-Diagnostics-Performance/Operational'; Id=100} -MaxEvents 1 | ForEach-Object { $_.ToXml() }`
	cmd := exec.CommandContext(ctx, syspath.PowerShell(), "-NoProfile", "-NonInteractive", "-Command", script)
	cmd.SysProcAttr = &syscall.SysProcAttr{HideWindow: true, CreationFlags: 0x08000000}
	raw, err := cmd.Output()
	if err == nil {
		parseWinEvent(string(raw), &out)
	}

	out.StartupItemCount = countAutoStartItems(ctx)
	return out
}

func parseWinEvent(text string, out *Metrics) {
	var e winEvent
	if err := xml.Unmarshal([]byte(text), &e); err != nil {
		return
	}
	if t, err := time.Parse(time.RFC3339Nano, e.System.TimeCreated.SystemTime); err == nil {
		out.BootTimestamp = t.UTC().Format(time.RFC3339)
	}
	var bootTotalMs, mainPathMs, postBootMs float64
	for _, d := range e.EventData.Data {
		v, err := strconv.ParseFloat(strings.TrimSpace(d.Value), 64)
		if err != nil {
			continue
		}
		switch d.Name {
		case "BootTime":
			bootTotalMs = v
		case "MainPathBootTime":
			mainPathMs = v
		case "BootPostBootTime":
			postBootMs = v
		}
	}
	out.OsLoaderSeconds = mainPathMs / 1000.0
	out.DesktopReadySeconds = postBootMs / 1000.0
	out.TotalBootSeconds = bootTotalMs / 1000.0
	if bios := bootTotalMs - mainPathMs - postBootMs; bios > 0 {
		out.BiosSeconds = bios / 1000.0
	}
}

func countAutoStartItems(ctx context.Context) int {
	script := `(@(Get-CimInstance Win32_StartupCommand) + @(Get-Service | Where-Object { $_.StartType -eq 'Automatic' })).Count`
	cmd := exec.CommandContext(ctx, syspath.PowerShell(), "-NoProfile", "-NonInteractive", "-Command", script)
	cmd.SysProcAttr = &syscall.SysProcAttr{HideWindow: true, CreationFlags: 0x08000000}
	raw, err := cmd.Output()
	if err != nil {
		return 0
	}
	if v, err := strconv.Atoi(strings.TrimSpace(string(raw))); err == nil {
		return v
	}
	return 0
}
