// Package bootperf collects per-boot timing (BIOS / loader / desktop-ready /
// total) and a startup-item count. macOS doesn't expose BIOS/loader (zero).
package bootperf

import "time"

// Metrics is the JSON the agent emits for boot_performance_collect.
type Metrics struct {
	BootTimestamp        string  `json:"bootTimestamp"`
	BiosSeconds          float64 `json:"biosSeconds"`
	OsLoaderSeconds      float64 `json:"osLoaderSeconds"`
	DesktopReadySeconds  float64 `json:"desktopReadySeconds"`
	TotalBootSeconds     float64 `json:"totalBootSeconds"`
	StartupItemCount     int     `json:"startupItemCount"`
	Source               string  `json:"source"`
}

// Collect returns metrics for the current boot. Best-effort — missing
// tools yield zero-valued fields rather than an error.
func Collect() Metrics {
	out := collect()
	if out.BootTimestamp == "" {
		out.BootTimestamp = time.Now().UTC().Format(time.RFC3339)
	}
	return out
}
