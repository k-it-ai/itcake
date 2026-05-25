// Package reliability collects a daily aggregate of host reliability
// signals (crashes, hangs, service failures, hardware errors) plus uptime.
package reliability

import "time"

// Aggregate is the daily reliability rollup.
type Aggregate struct {
	Day             string `json:"day"`
	UptimeSeconds   int64  `json:"uptimeSeconds"`
	Crashes         int    `json:"crashes"`
	Hangs           int    `json:"hangs"`
	ServiceFailures int    `json:"serviceFailures"`
	HardwareErrors  int    `json:"hardwareErrors"`
}

// Collect returns yesterday's aggregate (UTC). Best-effort.
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
