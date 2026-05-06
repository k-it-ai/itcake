// Package reliability collects a daily aggregate of host reliability
// signals — crashes, hangs, service failures, hardware errors — and the
// current uptime. The server pairs the daily payload with previous days
// to compute a 0..100 score and a 30-day trend.
package reliability

import "time"

// Aggregate is the daily reliability rollup the agent emits in stdout
// when a `collect_reliability` command runs. Field names match the
// server-side parsePayload contract.
type Aggregate struct {
	Day             string `json:"day"`
	UptimeSeconds   int64  `json:"uptimeSeconds"`
	Crashes         int    `json:"crashes"`
	Hangs           int    `json:"hangs"`
	ServiceFailures int    `json:"serviceFailures"`
	HardwareErrors  int    `json:"hardwareErrors"`
}

// Collect returns yesterday's aggregate (UTC). Per-platform implementations
// in collector_{linux,darwin,windows}.go shell out to the OS log tools;
// best-effort, missing tools yield zeros rather than an error so the
// command still completes successfully.
func Collect() Aggregate {
	out := collect()
	if out.Day == "" {
		out.Day = yesterday()
	}
	return out
}

func yesterday() string {
	return time.Now().UTC().AddDate(0, 0, -1).Format("2006-01-02")
}
