// Package bootperf collects per-boot timing — BIOS / loader / desktop-ready /
// total — plus a startup-item count. The server stores each successful
// collection as one row in agent_collector_results (kind='boot_performance')
// and dedups by bootTimestamp so re-running the command on the same boot
// session is a no-op.
//
// Per-platform implementations live in bootperf_{linux,darwin,windows}.go.
// macOS does not expose BIOS / loader phases — bios/loader come back as 0.
package bootperf

import "time"

// Metrics is the JSON the agent emits on stdout for a boot_performance_collect
// command. Field names match the server-side parsePayload contract.
type Metrics struct {
	BootTimestamp        string  `json:"bootTimestamp"`
	BiosSeconds          float64 `json:"biosSeconds"`
	OsLoaderSeconds      float64 `json:"osLoaderSeconds"`
	DesktopReadySeconds  float64 `json:"desktopReadySeconds"`
	TotalBootSeconds     float64 `json:"totalBootSeconds"`
	StartupItemCount     int     `json:"startupItemCount"`
	Source               string  `json:"source"`
}

// Collect returns metrics for the current boot session. Best-effort:
// missing tools yield zero-valued fields rather than an error so the
// command still completes successfully — the operator can still see
// the bootTimestamp and total uptime.
func Collect() Metrics {
	out := collect()
	if out.BootTimestamp == "" {
		out.BootTimestamp = time.Now().UTC().Format(time.RFC3339)
	}
	return out
}
