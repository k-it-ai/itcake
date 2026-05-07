// Package netdisc enumerates reachable hosts on the agent's local
// network. Pure detection — no active probing beyond ARP table reads,
// ICMP-or-TCP-fallback liveness, and bounded TCP connect port scans
// against a small operator-configurable port list.
package netdisc

import "time"

type Options struct {
	Subnets        []string `json:"subnets"`
	Methods        []string `json:"methods"`
	TimeoutSeconds int      `json:"timeoutSeconds"`
	Concurrency    int      `json:"concurrency"`
	PortTopN       int      `json:"portTopN"`
}

type Host struct {
	IP        string    `json:"ip"`
	MAC       string    `json:"mac"`
	Hostname  string    `json:"hostname"`
	OpenPorts []int     `json:"openPorts"`
	Vendor    string    `json:"vendor"`
	LastSeen  time.Time `json:"lastSeen"`
}

type Result struct {
	ScannedAt       time.Time `json:"scannedAt"`
	DurationSeconds int       `json:"durationSeconds"`
	SubnetsScanned  []string  `json:"subnetsScanned"`
	MethodsUsed     []string  `json:"methodsUsed"`
	Devices         []Host    `json:"devices"`
	Truncated       bool      `json:"truncated"`
	Errors          []string  `json:"errors"`
}
